/**
 * Session runner: starts, resumes and closes interactive `claude --remote-control` sessions in
 * detached tmux windows (one window per session, named `s<store id>`), so each shows up in the
 * Owner's Claude app (REQ-001-18). Hooks report turns back through the store (src/hook.ts).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role, RoleSettings } from "./config.ts";
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

export function remoteControlName(s: Pick<SessionRecord, "repo" | "role" | "kind" | "issues">): string {
  return s.kind === "batch" ? `${s.repo} planner` : `${s.repo}#${s.issues[0]} ${s.role}`;
}

export function claudeArgs(o: {
  name: string;
  prompt: string;
  settingsPath: string;
  addDir: string;
  model: RoleSettings;
  permissionMode: string;
  resumeId?: string;
}): string[] {
  const args: string[] = [];
  if (o.resumeId) args.push("--resume", o.resumeId);
  args.push("--add-dir", o.addDir, "--settings", o.settingsPath, "--model", o.model.model);
  if (o.model.effort) args.push("--effort", o.model.effort);
  // The prompt must follow a single-value flag: --add-dir is variadic, --remote-control has an optional value.
  args.push("--remote-control", o.name, "--permission-mode", o.permissionMode, o.prompt);
  return args;
}

export interface StartOptions {
  repo: string;
  role: Role;
  kind: "batch" | "issue";
  issues: number[];
  cwd: string;
  prompt: string;
  model: RoleSettings;
  permissionMode?: string;
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
    },
  ) {}

  sessionDir(id: number): string {
    return join(this.o.stateDir, "sessions", String(id));
  }

  start(opts: StartOptions): number {
    const id = this.o.store.createSession({ repo: opts.repo, role: opts.role, kind: opts.kind, issues: opts.issues });
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
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks }, null, 2));
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ cwd: opts.cwd, permissionMode: opts.permissionMode ?? "acceptEdits" }),
    );
    this.launch(id, opts.cwd, opts.prompt, opts.model, opts.permissionMode ?? "acceptEdits");
    return id;
  }

  /** Continues a session with a new prompt; refuses while it is running (REQ-001-19). */
  resume(id: number, prompt: string, model: RoleSettings): void {
    const s = this.mustGet(id);
    if (s.state === "running") throw new SessionBusyError(id);
    if (!s.claudeSessionId) throw new Error(`session ${id} has no Claude session id to resume`);
    const meta = JSON.parse(readFileSync(join(this.sessionDir(id), "meta.json"), "utf8")) as {
      cwd: string;
      permissionMode: string;
    };
    this.o.tmux.killWindow(`s${id}`);
    this.o.store.patchSession(id, { state: "running", resultFailures: 0, usageLimited: false });
    this.launch(id, meta.cwd, prompt, model, meta.permissionMode, s.claudeSessionId);
  }

  /** Closes an idle session (REQ-001-20); it can be resumed later. */
  close(id: number): void {
    const s = this.mustGet(id);
    if (s.state === "running") throw new SessionBusyError(id);
    this.o.tmux.killWindow(`s${id}`);
    this.o.store.patchSession(id, { state: "closed" });
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

  private launch(
    id: number,
    cwd: string,
    prompt: string,
    model: RoleSettings,
    permissionMode: string,
    resumeId?: string,
  ) {
    const s = this.mustGet(id);
    const dir = this.sessionDir(id);
    const resultPath = join(dir, "result.json");
    rmSync(resultPath, { force: true }); // a Result from an earlier turn must not pass for this one
    this.o.store.patchSession(id, { coordinatorPromptPending: true });
    const args = claudeArgs({
      name: remoteControlName(s),
      prompt: `${prompt}\n\n${resultInstructions(s.role, resultPath)}`,
      settingsPath: join(dir, "settings.json"),
      addDir: dir,
      model,
      permissionMode,
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
