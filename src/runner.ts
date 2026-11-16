/**
 * Session runner: starts, resumes and closes interactive `claude --remote-control` sessions in
 * detached tmux windows (one window per session, named `s<store id>`), so each shows up in the
 * Owner's Claude app (REQ-001-18). Hooks report turns back through the store (src/hook.ts).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Account, accountDir, copyTranscript, DEFAULT_ACCOUNT, freeAccount } from "./accounts.ts";
import type { Role, RoleSettings } from "./config.ts";
import { type Permissions, rolePermissions } from "./prompts.ts";
import { resultInstructions } from "./results.ts";
import type { SessionRecord, Store } from "./store.ts";
import type { Tmux } from "./tmux.ts";

/** REQ-001-55: hosts every Role's shell commands may reach, to read GitHub with the session's read-only token. */
export const GITHUB_DOMAINS = [
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
];

/**
 * REQ-001-58: sockets that control the host from outside an Implementer's sandbox: the folder of the Coordinator's
 * tmux socket (a `tmux new-window` would run outside the sandbox) and the user's runtime folder (session bus,
 * systemd). The sandbox hides them, because its Unix socket block is off for Implementers (REQ-001-53).
 */
export function hostControlSockets(tmuxSocket: string, uid: number): string[] {
  return [dirname(tmuxSocket), `/run/user/${uid}`];
}

/**
 * REQ-001-58: groups whose members can reach a root daemon through a socket the sandbox does not hide
 * (e.g. `/var/run/docker.sock`); `bun run doctor` warns when the Coordinator's user is in one.
 */
const SOCKET_GROUPS = ["docker", "lxd", "incus", "libvirt", "podman"];
export const socketGroups = (groups: string[]): string[] => groups.filter((g) => SOCKET_GROUPS.includes(g));

/** What a resume needs to write the session folder again: the start options that don't change. */
interface SessionMeta {
  cwd: string;
  sandboxDomains?: string[];
}

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"] as const;
const TRUST_DIALOG = /Yes, I trust this folder/;
/** REQ-001-56: newer Claude Code versions also ask about each `--add-dir` folder (docs/known-pitfalls.md). */
const ADD_DIR_DIALOG = /Adding a new directory[\s\S]*Yes, add it/;
const WINDOW = /^s(\d+)$/;

export class SessionBusyError extends Error {
  constructor(id: number) {
    super(`session ${id} is running (possibly the Owner is chatting with it); try again once it is idle`);
    this.name = "SessionBusyError";
  }
}

/** REQ-001-44: a session that could not be launched; it is recorded as closed. */
export class SessionStartError extends Error {
  constructor(
    readonly session: SessionRecord,
    cause: unknown,
  ) {
    super(`could not start the session: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SessionStartError";
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

/** The arguments before the prompt, which `launch` appends from the session's prompt file (REQ-001-45). */
export function claudeArgs(o: {
  name: string;
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
  args.push("--remote-control", o.name, "--permission-mode", o.permissions.permissionMode);
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
      /** REQ-001-58: hidden from Implementers, who may open Unix sockets; without them they keep the block. */
      controlSockets?: string[];
      /** In priority order (REQ-004-01); default: the implicit Account in Claude's default folder. */
      accounts?: Account[];
      /** Where Claude's default folder `~/.claude` lives. */
      home?: string;
      /** REQ-001-55: the current read-only GitHub token for a repository, if there is one. */
      readToken?: (repo: string) => string | undefined;
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
    try {
      this.prepare(id, opts);
      this.launch(id, opts.cwd, opts.prompt, opts.model);
    } catch (e) {
      throw this.startFailed(id, e);
    }
    return id;
  }

  /** Writes the session folder: per-session hooks, permissions and sandbox, and what a resume needs. */
  private prepare(id: number, opts: StartOptions): void {
    const meta: SessionMeta = { cwd: opts.cwd, sandboxDomains: opts.sandboxDomains ?? [] };
    mkdirSync(this.sessionDir(id), { recursive: true });
    writeFileSync(join(this.sessionDir(id), "meta.json"), JSON.stringify(meta));
    this.writeSettings(id, opts.role, meta);
  }

  /** Per-session hooks, permissions and sandbox; rewritten on every resume, so it gets the current rules (REQ-001-55). */
  private writeSettings(id: number, role: Role, meta: SessionMeta): void {
    const dir = this.sessionDir(id);
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
    // REQ-001-53 / REQ-001-58: the host's browser needs socket(AF_UNIX), which the sandbox's seccomp filter blocks,
    // and the only switch opens every Unix socket. So only an Implementer gets it, and only with the host's control
    // sockets hidden; the sandbox's own network namespace keeps abstract sockets and host TCP out of reach.
    const controlSockets = this.o.controlSockets ?? [];
    const unixSockets = role === "implementer" && controlSockets.length > 0;
    const sandbox = rolePermissions(role, dir).sandbox
      ? {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          // REQ-001-25: never run shell commands unsandboxed, e.g. when a sandbox dependency is missing.
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          filesystem: {
            denyRead: unixSockets ? [...secrets, ...controlSockets] : secrets,
            // REQ-001-25: the sandbox lets shell commands write to the cwd, and allowed read-only git can write
            // files (`git log --output=<file>`). Deny beats that allow, so a Planner's or Reviewer's shell keeps
            // only its session folder and the sandbox's temporary folder (docs/known-pitfalls.md).
            ...(role === "implementer" ? {} : { denyWrite: [meta.cwd] }),
          },
          network: {
            allowedDomains: [...(role === "implementer" ? (meta.sandboxDomains ?? []) : []), ...GITHUB_DOMAINS],
            ...(unixSockets ? { allowAllUnixSockets: true } : {}),
          },
        }
      : undefined;
    // REQ-001-26: deny rules cover the file tools; sandbox.filesystem.denyRead covers shell commands.
    const permissions = { deny: secrets.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]) };
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks, permissions, sandbox }, null, 2));
  }

  /** Reads what a resume needs; a session folder from before REQ-001-55 kept its domains only in its settings. */
  private readMeta(id: number): SessionMeta {
    const dir = this.sessionDir(id);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as SessionMeta;
    if (meta.sandboxDomains) return meta;
    try {
      const old = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      const domains: unknown = old?.sandbox?.network?.allowedDomains;
      const kept = Array.isArray(domains)
        ? domains.filter((d) => typeof d === "string" && !GITHUB_DOMAINS.includes(d))
        : [];
      return { ...meta, sandboxDomains: kept };
    } catch {
      return { ...meta, sandboxDomains: [] };
    }
  }

  /** REQ-001-55: gives the session's `gh` the current read-only token of its repository, through its config folder. */
  private writeGitHubAccess(id: number, repo: string): void {
    const ghDir = join(this.sessionDir(id), "gh");
    mkdirSync(ghDir, { recursive: true });
    const token = this.o.readToken?.(repo);
    const hosts = join(ghDir, "hosts.yml");
    if (token)
      writeFileSync(hosts, `github.com:\n    oauth_token: ${token}\n    git_protocol: https\n`, { mode: 0o600 });
    else rmSync(hosts, { force: true });
  }

  /** REQ-001-55: renews the token of every live session; tokens expire after an hour. */
  refreshGitHubAccess(): void {
    for (const id of this.liveSessionIds()) {
      const s = this.o.store.session(id);
      if (s) this.writeGitHubAccess(id, s.repo);
    }
  }

  /** Continues a session with a new prompt; refuses while it is running (REQ-001-19). */
  resume(id: number, prompt: string, model: RoleSettings, opts: { keepResult?: boolean } = {}): void {
    const s = this.mustGet(id);
    if (this.isBusy(s)) throw new SessionBusyError(id);
    if (!s.claudeSessionId) throw new Error(`session ${id} has no Claude session id to resume`);
    const meta = this.readMeta(id);
    try {
      this.o.tmux.killWindow(`s${id}`);
      this.writeSettings(id, s.role, meta);
      this.o.store.patchSession(id, { state: "running", resultFailures: 0, usageLimited: false });
      this.launch(id, meta.cwd, prompt, model, s.claudeSessionId, opts.keepResult);
    } catch (e) {
      throw this.startFailed(id, e);
    }
  }

  /** REQ-001-44: a session whose launch failed is closed, so it is not taken for an interrupted one (REQ-001-16). */
  private startFailed(id: number, cause: unknown): SessionStartError {
    this.o.store.patchSession(id, { state: "closed", coordinatorPromptPending: false });
    return new SessionStartError(this.mustGet(id), cause);
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

  /**
   * Answers the folder trust dialog that blocks `claude` in a new folder, and the question whether to trust the
   * session's own folder given with `--add-dir` (REQ-001-56); any other folder stays unanswered (docs/known-pitfalls.md).
   */
  answerDialogs(): void {
    for (const id of this.liveSessionIds()) {
      const screen = this.o.tmux.capture(`s${id}`);
      const ownFolder = this.sessionDir(id);
      const asksOwnFolder = ADD_DIR_DIALOG.test(screen) && screen.split("\n").some((line) => line.trim() === ownFolder);
      if (TRUST_DIALOG.test(screen) || asksOwnFolder) {
        this.o.tmux.sendKeys(`s${id}`, "Down");
        this.o.tmux.sendKeys(`s${id}`, "Enter");
      }
    }
  }

  /** What the session's window shows now, e.g. to say why it did not start (REQ-001-57). */
  screen(id: number): string {
    return this.o.tmux.capture(`s${id}`);
  }

  /** REQ-001-57: ends a session that never took its prompt, even though it counts as running. */
  abandon(id: number): void {
    this.mustGet(id);
    this.o.tmux.killWindow(`s${id}`);
    this.o.store.patchSession(id, { state: "closed", coordinatorPromptPending: false });
  }

  /** REQ-004-01: the first Account that isn't paused; the first one if all are (the scheduler holds work back then). */
  private chooseAccount(): Account {
    const accounts = this.o.accounts?.length ? this.o.accounts : [DEFAULT_ACCOUNT];
    const now = this.o.store.clock();
    return freeAccount(accounts, (n) => this.o.store.pausedUntil(n), now) ?? (accounts[0] as Account);
  }

  /** The folder of a recorded Account; sessions from before spec 004 ran in Claude's default folder. */
  private recordedDir(name: string | null): string {
    const home = this.o.home ?? homedir();
    const a = this.o.accounts?.find((x) => x.name === name) ?? DEFAULT_ACCOUNT;
    return accountDir(a, home);
  }

  private launch(id: number, cwd: string, prompt: string, model: RoleSettings, resumeId?: string, keepResult = false) {
    const s = this.mustGet(id);
    const dir = this.sessionDir(id);
    const account = this.chooseAccount();
    const accountFolder = accountDir(account, this.o.home ?? homedir());
    // REQ-001-17: `--resume` finds only transcripts in the Account's own folder.
    if (resumeId) {
      const from = this.recordedDir(s.account);
      if (from !== accountFolder) copyTranscript(resumeId, from, accountFolder);
    }
    const resultPath = join(dir, "result.json");
    // A Result from an earlier turn must not pass for this one, unless the turn has no new task (a wake).
    if (!keepResult) rmSync(resultPath, { force: true });
    this.o.store.patchSession(id, { coordinatorPromptPending: true });
    this.o.store.setAccount(id, account.name);
    // REQ-001-45: tmux refuses long commands, so the prompt goes through a file. The shell substitutes it as one
    // argument and does not interpret its content (issue text is untrusted).
    const promptPath = join(dir, "prompt.md");
    writeFileSync(promptPath, keepResult ? prompt : `${prompt}\n\n${resultInstructions(s.role, resultPath)}`);
    const args = claudeArgs({
      name: remoteControlName(s),
      settingsPath: join(dir, "settings.json"),
      addDir: dir,
      model,
      permissions: rolePermissions(s.role, dir),
      resumeId,
    });
    // REQ-001-55: gh reads its token from hosts.yml on every call, so a renewed token reaches a running session.
    this.writeGitHubAccess(id, s.repo);
    const gh = `GH_CONFIG_DIR=${shellQuote([join(dir, "gh")])} GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1 `;
    const env = `${gh}${account.configDir ? `CLAUDE_CONFIG_DIR=${shellQuote([account.configDir])} ` : ""}`;
    const command = `${env}${shellQuote([this.o.claudeBin ?? "claude", ...args])} "$(cat ${shellQuote([promptPath])})"`;
    this.o.tmux.newWindow(`s${id}`, cwd, command);
  }

  private mustGet(id: number): SessionRecord {
    const s = this.o.store.session(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  }
}
