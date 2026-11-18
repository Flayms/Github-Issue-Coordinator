/**
 * Session runner: starts, resumes and closes interactive `claude --remote-control` sessions in
 * detached tmux windows (one window per session, named `s<store id>`), so each shows up in the
 * Owner's Claude app (REQ-001-18). Hooks report turns back through the store (src/hook.ts).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Account, accountDir, copyTranscript, DEFAULT_ACCOUNT, freeAccount } from "./accounts.ts";
import type { Role, RoleSettings } from "./config.ts";
import { resultInstructions } from "./results.ts";
import type { SessionRecord, Store } from "./store.ts";
import type { Tmux } from "./tmux.ts";

/** What a resume needs to write the session folder again: the start options that don't change. */
interface SessionMeta {
  cwd: string;
}

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"] as const;
/** Screens the Coordinator answers with Down, Enter: the second option, which is "yes" on both. */
const DIALOGS = [
  /Yes, I trust this folder/,
  // REQ-005-01: shown once per Claude config folder before it runs with skipped permissions.
  /Bypass Permissions mode[\s\S]*Yes, I accept/,
];
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

/**
 * REQ-005-07: the instruction files of every folder above a session's own, for `claudeMdExcludes`. Claude Code loads
 * CLAUDE.md from each of them, so a Worktree inside the Coordinator's checkout would load the Coordinator's own
 * instructions and stop at the screen asking about their imports (#87). The Owner's own `~/.claude` still loads.
 */
export function parentInstructionFiles(cwd: string, home: string): string[] {
  const files: string[] = [];
  const userDir = resolve(home);
  for (let dir = dirname(resolve(cwd)); ; dir = dirname(dir)) {
    const at = dir === "/" ? "" : dir;
    files.push(`${at}/CLAUDE.md`, `${at}/CLAUDE.local.md`);
    if (dir !== userDir) files.push(`${at}/.claude/CLAUDE.md`, `${at}/.claude/rules/**`);
    if (dirname(dir) === dir) return files;
  }
}

/** The arguments before the prompt, which `launch` appends from the session's prompt file (REQ-001-45). */
export function claudeArgs(o: {
  name: string;
  settingsPath: string;
  model: RoleSettings;
  resumeId?: string;
}): string[] {
  const args: string[] = [];
  if (o.resumeId) args.push("--resume", o.resumeId);
  // REQ-005-01: agents run unrestricted on the Coordinator's VM.
  args.push("--settings", o.settingsPath, "--remote-control", o.name, "--dangerously-skip-permissions");
  // The prompt must follow a single-value flag: --remote-control has an optional value.
  args.push("--model", o.model.model);
  if (o.model.effort) args.push("--effort", o.model.effort);
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
      /** In priority order (REQ-004-01); default: the implicit Account in Claude's default folder. */
      accounts?: Account[];
      /** Where Claude's default folder `~/.claude` lives. */
      home?: string;
    },
  ) {}

  sessionDir(id: number): string {
    return join(this.o.stateDir, "sessions", String(id));
  }

  /** REQ-001-62: the session's own temp folder, on the disk of the state folder rather than a small `/tmp`. */
  private tmpDir(id: number): string {
    return join(this.sessionDir(id), "tmp");
  }

  /** REQ-001-62: a closed session's temp files (e.g. headless-Chrome profiles) have no value. */
  private removeTmp(id: number): void {
    rmSync(this.tmpDir(id), { recursive: true, force: true });
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

  /** Writes the session folder: per-session hooks, and what a resume needs. */
  private prepare(id: number, opts: StartOptions): void {
    mkdirSync(this.sessionDir(id), { recursive: true });
    writeFileSync(join(this.sessionDir(id), "meta.json"), JSON.stringify({ cwd: opts.cwd } satisfies SessionMeta));
    this.writeSettings(id, opts.cwd);
  }

  /**
   * REQ-005-01: the hooks and, for REQ-005-07, the CLAUDE.md files above the session's folder to skip; rewritten on
   * every resume, so a session folder from an older Coordinator loses its sandbox.
   */
  private writeSettings(id: number, cwd: string): void {
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
    const claudeMdExcludes = parentInstructionFiles(cwd, this.o.home ?? homedir());
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks, claudeMdExcludes }, null, 2));
  }

  /** Continues a session with a new prompt; refuses while it is running (REQ-001-19). */
  resume(id: number, prompt: string, model: RoleSettings, opts: { keepResult?: boolean } = {}): void {
    const s = this.mustGet(id);
    if (this.isBusy(s)) throw new SessionBusyError(id);
    if (!s.claudeSessionId) throw new Error(`session ${id} has no Claude session id to resume`);
    const meta = JSON.parse(readFileSync(join(this.sessionDir(id), "meta.json"), "utf8")) as SessionMeta;
    try {
      this.o.tmux.killWindow(`s${id}`);
      this.writeSettings(id, meta.cwd);
      this.o.store.patchSession(id, { state: "running", resultFailures: 0, usageLimited: false });
      this.launch(id, meta.cwd, prompt, model, s.claudeSessionId, opts.keepResult);
    } catch (e) {
      throw this.startFailed(id, e);
    }
  }

  /** REQ-001-44: a session whose launch failed is closed, so it is not taken for an interrupted one (REQ-001-16). */
  private startFailed(id: number, cause: unknown): SessionStartError {
    this.removeTmp(id);
    this.o.store.patchSession(id, { state: "closed", coordinatorPromptPending: false });
    return new SessionStartError(this.mustGet(id), cause);
  }

  /** Closes an idle session (REQ-001-20); it can be resumed later. */
  close(id: number): void {
    const s = this.mustGet(id);
    if (this.isBusy(s)) throw new SessionBusyError(id);
    this.o.tmux.killWindow(`s${id}`);
    this.removeTmp(id);
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

  /** Answers the folder trust dialog and the Bypass Permissions warning (REQ-005-01); any other screen stays (REQ-001-57). */
  answerDialogs(): void {
    for (const id of this.liveSessionIds()) {
      const screen = this.o.tmux.capture(`s${id}`);
      if (DIALOGS.some((d) => d.test(screen))) {
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
    this.removeTmp(id);
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
    const args = claudeArgs({ name: remoteControlName(s), settingsPath: join(dir, "settings.json"), model, resumeId });
    // REQ-001-62: temp files go to the session's own folder (`os.tmpdir()`, `mktemp`, Chrome profiles, Claude Code's own).
    const tmp = this.tmpDir(id);
    mkdirSync(tmp, { recursive: true });
    const tmpEnv = `TMPDIR=${shellQuote([tmp])} CLAUDE_CODE_TMPDIR=${shellQuote([tmp])} `;
    // REQ-005-01: Claude Code refuses skipped permissions as root unless IS_SANDBOX=1 is set.
    const env = `${tmpEnv}IS_SANDBOX=1 ${account.configDir ? `CLAUDE_CONFIG_DIR=${shellQuote([account.configDir])} ` : ""}`;
    const command = `${env}${shellQuote([this.o.claudeBin ?? "claude", ...args])} "$(cat ${shellQuote([promptPath])})"`;
    this.o.tmux.newWindow(`s${id}`, cwd, command);
  }

  private mustGet(id: number): SessionRecord {
    const s = this.o.store.session(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  }
}
