/**
 * Session runner: starts, resumes and closes interactive `claude --remote-control` sessions in
 * detached tmux windows (one window per session, named `s<store id>`), so each shows up in the
 * Owner's Claude app (REQ-001-18). Hooks report turns back through the store (src/hook.ts).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role, RoleSettings } from "./config.ts";
import { type Permissions, rolePermissions } from "./prompts.ts";
import { resultInstructions } from "./results.ts";
import type { SessionRecord, Store } from "./store.ts";
import type { Tmux } from "./tmux.ts";

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"] as const;
const TRUST_DIALOG = /Yes, I trust this folder/;
const WINDOW = /^s(\d+)$/;

export class SessionBusyError extends Error {
  constructor(id: number) {
    super(`session ${id} is running (possibly the Owner is chatting with it); try again once it is idle`);
    this.name = "SessionBusyError";
  }
}

export const shellQuote = (args: string[]): string => args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");

const TITLE_LIMIT = 50;

/** REQ-001-33: `#<n> <issue title> · <Role> · <repo name>`, so the Owner sees the context in the Claude app. */
export function remoteControlName(s: Pick<SessionRecord, "repo" | "role" | "kind" | "issues" | "title">): string {
  const repoName = s.repo.split("/").pop() ?? s.repo;
  const role = s.role.charAt(0).toUpperCase() + s.role.slice(1);
  if (s.kind === "batch") return `${role} · ${s.issues.map((n) => `#${n}`).join(", ")} · ${repoName}`;
  // Sessions stored before titles were kept (REQ-001-18's name).
  if (!s.title) return `${s.repo}#${s.issues[0]} ${s.role}`;
  const title = s.title.length > TITLE_LIMIT ? `${s.title.slice(0, TITLE_LIMIT - 1)}…` : s.title;
  const more = s.issues.length > 1 ? ` (+${s.issues.length - 1})` : "";
  return `#${s.issues[0]} ${title}${more} · ${role} · ${repoName}`;
}

export function claudeArgs(o: {
  name: string;
  prompt: string;
  settingsPath: string;
  addDir: string;
  model: RoleSettings;
  permissions: Permissions;
  resumeId?: string;
}): string[] {
  const args: string[] = [];
  if (o.resumeId) args.push("--resume", o.resumeId);
  args.push("--add-dir", o.addDir, "--settings", o.settingsPath, "--model", o.model.model);
  if (o.model.effort) args.push("--effort", o.model.effort);
  if (o.permissions.allowedTools.length) args.push("--allowedTools", ...o.permissions.allowedTools);
  // The prompt must follow a single-value flag: --add-dir is variadic, --remote-control has an optional value.
  args.push("--remote-control", o.name, "--permission-mode", o.permissions.permissionMode, o.prompt);
  return args;
}

export interface StartOptions {
  repo: string;
  role: Role;
  kind: "batch" | "issue";
  issues: number[];
  /** Title of the first issue, shown in the Remote Control name (REQ-001-33). */
  title?: string | null;
  cwd: string;
  prompt: string;
  model: RoleSettings;
  /** Network domains the session's sandboxed shell commands may reach (Implementer only, REQ-001-25). */
  sandboxDomains?: string[];
}

export class SessionRunner {
  constructor(
    private readonly o: {
      store: Store;
      tmux: Tmux;
      /** Holds `sessions/<id>/` (settings, Result, hook log); outside every repository. */
      stateDir: string;
      dbPath: string;
      /** How to run src/hook.ts, e.g. `[process.execPath, "/…/src/hook.ts"]`. */
      hookCommand: string[];
      claudeBin?: string;
      /** Files and folders no agent may read: the App key, Claude's credentials (REQ-001-26). */
      secretPaths?: string[];
    },
  ) {}

  sessionDir(id: number): string {
    return join(this.o.stateDir, "sessions", String(id));
  }

  start(opts: StartOptions): number {
    const id = this.o.store.createSession({
      repo: opts.repo,
      role: opts.role,
      kind: opts.kind,
      issues: opts.issues,
      title: opts.title,
    });
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true });
    const hooks = Object.fromEntries(
      HOOK_EVENTS.map((ev) => [
        ev,
        [
          {
            hooks: [
              { type: "command", command: shellQuote([...this.o.hookCommand, ev, this.o.dbPath, String(id), dir]) },
            ],
          },
        ],
      ]),
    );
    const secrets = this.o.secretPaths ?? [];
    const sandbox = rolePermissions(opts.role, dir).sandbox
      ? {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          // REQ-001-25: never run shell commands unsandboxed, e.g. when a sandbox dependency is missing.
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          filesystem: { denyRead: secrets },
          network: { allowedDomains: opts.role === "implementer" ? (opts.sandboxDomains ?? []) : [] },
        }
      : undefined;
    // REQ-001-26: deny rules cover the file tools; sandbox.filesystem.denyRead covers shell commands.
    const permissions = { deny: secrets.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]) };
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks, permissions, sandbox }, null, 2));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ cwd: opts.cwd }));
    this.launch(id, opts.cwd, opts.prompt, opts.model);
    return id;
  }

  /** Continues a session with a new prompt; refuses while it is running (REQ-001-19). */
  resume(id: number, prompt: string, model: RoleSettings, opts: { keepResult?: boolean } = {}): void {
    const s = this.mustGet(id);
    if (this.isBusy(s)) throw new SessionBusyError(id);
    if (!s.claudeSessionId) throw new Error(`session ${id} has no Claude session id to resume`);
    const meta = JSON.parse(readFileSync(join(this.sessionDir(id), "meta.json"), "utf8")) as { cwd: string };
    this.o.tmux.killWindow(`s${id}`);
    this.o.store.patchSession(id, { state: "running", resultFailures: 0, usageLimited: false });
    this.launch(id, meta.cwd, prompt, model, s.claudeSessionId, opts.keepResult);
  }

  /** Closes an idle session (REQ-001-20); it can be resumed later. */
  close(id: number): void {
    const s = this.mustGet(id);
    if (this.isBusy(s)) throw new SessionBusyError(id);
    this.o.tmux.killWindow(`s${id}`);
    this.o.store.patchSession(id, { state: "closed" });
  }

  /** Running with a live window; a "running" session without one was interrupted (REQ-001-16). */
  private isBusy(s: SessionRecord): boolean {
    return s.state === "running" && this.liveSessionIds().has(s.id);
  }

  /** Store ids of sessions whose tmux window is alive. */
  liveSessionIds(): Set<number> {
    return new Set(this.o.tmux.listWindows().flatMap((w) => (WINDOW.test(w) ? [Number(w.slice(1))] : [])));
  }

  /** Answers the folder trust dialog that blocks `claude` in a new folder (docs/known-pitfalls.md). */
  answerDialogs(): void {
    for (const id of this.liveSessionIds()) {
      if (TRUST_DIALOG.test(this.o.tmux.capture(`s${id}`))) {
        this.o.tmux.sendKeys(`s${id}`, "Down");
        this.o.tmux.sendKeys(`s${id}`, "Enter");
      }
    }
  }

  private launch(id: number, cwd: string, prompt: string, model: RoleSettings, resumeId?: string, keepResult = false) {
    const s = this.mustGet(id);
    const dir = this.sessionDir(id);
    const resultPath = join(dir, "result.json");
    // A Result from an earlier turn must not pass for this one, unless the turn has no new task (a wake).
    if (!keepResult) rmSync(resultPath, { force: true });
    this.o.store.patchSession(id, { coordinatorPromptPending: true });
    const args = claudeArgs({
      name: remoteControlName(s),
      prompt: keepResult ? prompt : `${prompt}\n\n${resultInstructions(s.role, resultPath)}`,
      settingsPath: join(dir, "settings.json"),
      addDir: dir,
      model,
      permissions: rolePermissions(s.role, dir),
      resumeId,
    });
    this.o.tmux.newWindow(`s${id}`, cwd, shellQuote([this.o.claudeBin ?? "claude", ...args]));
  }

  private mustGet(id: number): SessionRecord {
    const s = this.o.store.session(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  }
}
