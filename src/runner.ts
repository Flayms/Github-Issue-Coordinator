/**
 * Session runner: starts, resumes and closes interactive agent sessions in detached tmux windows (one window per
 * session, named `s<store id>`), each in the CLI of its Harness (REQ-006-01); Claude Code's show up in the Owner's
 * Claude app (REQ-001-18). Hooks report turns back through the store (src/hook.ts).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Account, accountDir, accountsOf, DEFAULT_ACCOUNT, freeAccount } from "./accounts.ts";
import type { Role, RoleSettings } from "./config.ts";
import { type Harness, type HarnessName, harnessByName } from "./harness/index.ts";
import { harnessOfModel } from "./models.ts";
import { resultInstructions } from "./results.ts";
import type { SessionRecord, Store } from "./store.ts";
import type { Tmux } from "./tmux.ts";

/** What a resume needs to write the session folder again: the start options that don't change. */
interface SessionMeta {
  cwd: string;
}

export { claudeArgs, parentInstructionFiles } from "./harness/claude.ts";

const WINDOW = /^s(\d+)$/;

/** REQ-006-02: work for a Harness that has no Account in `config.ts`. */
export class NoAccountError extends Error {
  constructor(harness: Harness) {
    super(`no Account of ${harness.label} (accounts with harness: "${harness.name}" in config.ts)`);
    this.name = "NoAccountError";
  }
}

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
      /** The CLI to run instead of each Harness's own, e.g. a fake one in tests. */
      bins?: Partial<Record<HarnessName, string>>;
      /** In priority order (REQ-004-01); default: the implicit Account in Claude's default folder. */
      accounts?: Account[];
      /** Where the Harnesses' default folders, e.g. `~/.claude`, live. */
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

  /** REQ-006-01: a new session runs on the Harness of its model. */
  start(opts: StartOptions): number {
    const id = this.o.store.createSession({
      repo: opts.repo,
      role: opts.role,
      kind: opts.kind,
      issues: opts.issues,
      title: opts.title,
      harness: harnessOfModel(opts.model.model),
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

  /** The hook command line of one event for a session. */
  private hook(id: number): (event: string) => string {
    return (ev) => shellQuote([...this.o.hookCommand, ev, this.o.dbPath, String(id), this.sessionDir(id)]);
  }

  /** The Harness's per-session config (REQ-005-01), rewritten on every resume. */
  private writeSettings(id: number, cwd: string): void {
    const harness = this.harnessOf(id);
    harness.writeSessionConfig({ sessionDir: this.sessionDir(id), cwd, home: this.home(), hook: this.hook(id) });
  }

  /** REQ-006-03: the Harness a session started on; a resume stays on it. */
  private harnessOf(id: number): Harness {
    return harnessByName(this.mustGet(id).harness);
  }

  private home(): string {
    return this.o.home ?? homedir();
  }

  /** Continues a session with a new prompt; refuses while it is running (REQ-001-19). */
  resume(id: number, prompt: string, model: RoleSettings, opts: { keepResult?: boolean } = {}): void {
    const s = this.mustGet(id);
    if (this.isBusy(s)) throw new SessionBusyError(id);
    // E.g. "no Claude session id", "no Codex session id".
    const vendor = harnessByName(s.harness).label.split(" ")[0];
    if (!s.agentSessionId) throw new Error(`session ${id} has no ${vendor} session id to resume`);
    const meta = JSON.parse(readFileSync(join(this.sessionDir(id), "meta.json"), "utf8")) as SessionMeta;
    try {
      this.o.tmux.killWindow(`s${id}`);
      this.writeSettings(id, meta.cwd);
      this.o.store.patchSession(id, {
        state: "running",
        resultFailures: 0,
        usageLimited: false,
        usageLimitResetsAt: null,
      });
      this.launch(id, meta.cwd, prompt, model, s.agentSessionId, opts.keepResult);
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

  /**
   * Answers its Harness's folder trust dialog and, for Claude, the Bypass Permissions warning (REQ-005-01); any other
   * screen stays (REQ-001-57).
   */
  answerDialogs(): void {
    for (const id of this.liveSessionIds()) {
      const s = this.o.store.session(id);
      if (!s) continue;
      const screen = this.o.tmux.capture(`s${id}`);
      const dialog = harnessByName(s.harness).dialogs.find((d) => d.screen.test(screen));
      for (const key of dialog?.keys ?? []) this.o.tmux.sendKeys(`s${id}`, key);
    }
  }

  /**
   * REQ-006-04: ends the turn of a running session whose Harness ended it without the turn-end hook, e.g. Codex on the
   * usage limit (REQ-001-17). Returns the ids it marked.
   */
  detectEndedTurns(): number[] {
    const marked: number[] = [];
    for (const id of this.liveSessionIds()) {
      const s = this.o.store.session(id);
      const harness = s && harnessByName(s.harness);
      if (!s || !harness?.endedTurn || s.state !== "running" || s.coordinatorPromptPending || !s.transcriptPath)
        continue;
      const ended = harness.endedTurn(s.transcriptPath);
      if (!ended?.usageLimited) continue;
      this.o.store.patchSession(id, { state: "idle", usageLimited: true, usageLimitResetsAt: ended.resetsAt ?? null });
      marked.push(id);
    }
    return marked;
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

  /**
   * REQ-004-01: the first Account of the Harness that isn't paused; the first one if all are (the scheduler holds work
   * back then). REQ-006-02: only Accounts of the session's Harness.
   */
  private chooseAccount(harness: Harness): Account {
    const accounts = accountsOf(this.o.accounts?.length ? this.o.accounts : [DEFAULT_ACCOUNT], harness.name);
    if (!accounts.length) throw new NoAccountError(harness);
    const now = this.o.store.clock();
    return freeAccount(accounts, (n) => this.o.store.pausedUntil(n), now) ?? (accounts[0] as Account);
  }

  /** The recorded Account; sessions from before spec 004 ran in Claude's default folder. */
  private recordedAccount(name: string | null): Account {
    return this.o.accounts?.find((x) => x.name === name) ?? DEFAULT_ACCOUNT;
  }

  private launch(id: number, cwd: string, prompt: string, model: RoleSettings, resumeId?: string, keepResult = false) {
    const s = this.mustGet(id);
    const dir = this.sessionDir(id);
    const harness = harnessByName(s.harness);
    const recorded = this.recordedAccount(s.account);
    const account = this.chooseAccount(harness);
    const accountFolder = accountDir(account, this.home());
    // REQ-001-17: `--resume` finds only transcripts in the Account's own folder.
    if (resumeId && harness.moveTranscript) {
      const from = accountDir(recorded, this.home());
      if (from !== accountFolder) harness.moveTranscript(resumeId, from, accountFolder);
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
    const args = harness.args({ sessionDir: dir, name: remoteControlName(s), model, resumeId, hook: this.hook(id) });
    // REQ-001-62: temp files go to the session's own folder (`os.tmpdir()`, `mktemp`, Chrome profiles, the CLI's own).
    const tmp = this.tmpDir(id);
    mkdirSync(tmp, { recursive: true });
    const vars: [string, string][] = [["TMPDIR", tmp], ...Object.entries(harness.env({ tmp }))];
    if (account.configDir) vars.push([harness.accountEnv, account.configDir]);
    const env = vars.map(([k, v]) => `${k}=${/^\w+$/.test(v) ? v : shellQuote([v])} `).join("");
    const bin = this.o.bins?.[harness.name] ?? harness.bin;
    const command = `${env}${shellQuote([bin, ...args])} "$(cat ${shellQuote([promptPath])})"`;
    this.o.tmux.newWindow(`s${id}`, cwd, command);
  }

  private mustGet(id: number): SessionRecord {
    const s = this.o.store.session(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  }
}
