import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeArgs,
  remoteControlName,
  SessionBusyError,
  SessionRunner,
  SessionStartError,
  shellQuote,
} from "../src/runner.ts";
import { Store } from "../src/store.ts";
import type { Tmux } from "../src/tmux.ts";

class FakeTmux implements Tmux {
  windows = new Map<string, { cwd: string; command: string; pane: string }>();
  keys: [string, string[]][] = [];
  /** Makes newWindow throw, like `tmux new-window` refusing a command. */
  failWith: string | null = null;
  listWindows() {
    return [...this.windows.keys()];
  }
  newWindow(name: string, cwd: string, command: string) {
    if (this.failWith) throw new Error(this.failWith);
    this.windows.set(name, { cwd, command, pane: "" });
  }
  killWindow(name: string) {
    this.windows.delete(name);
  }
  capture(name: string) {
    return this.windows.get(name)?.pane ?? "";
  }
  sendKeys(name: string, ...keys: string[]) {
    this.keys.push([name, keys]);
  }
}

let dir: string;
let store: Store;
let tmux: FakeTmux;
let runner: SessionRunner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-"));
  store = new Store(join(dir, "state.db"));
  tmux = new FakeTmux();
  runner = new SessionRunner({
    store,
    tmux,
    stateDir: dir,
    dbPath: join(dir, "state.db"),
    hookCommand: ["bun", "/app/src/hook.ts"],
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true });
});

/** The prompt the session's last launch handed to `claude` (REQ-001-45). */
const promptOf = (id: number) => readFileSync(join(dir, "sessions", String(id), "prompt.md"), "utf8");

/** REQ-001-62: the session's own temp folder, and the variables that send temp files there. */
const tmpOf = (id: number) => join(dir, "sessions", String(id), "tmp");
const tmpEnv = (id: number) => `TMPDIR=${shellQuote([tmpOf(id)])} CLAUDE_CODE_TMPDIR=${shellQuote([tmpOf(id)])} `;

const startImplementer = () =>
  runner.start({
    repo: "octo/app",
    role: "implementer",
    kind: "issue",
    issues: [5],
    title: "Add dark mode",
    cwd: "/work/app-5",
    prompt: "Implement #5",
    model: { model: "sonnet", effort: "high" },
  });

describe("claude command line", () => {
  test("REQ-001-18 / REQ-001-22 / REQ-005-01 registers with Remote Control under its name, with model, effort, hooks and skipped permissions; a single-value flag last", () => {
    expect(
      claudeArgs({
        name: "octo/app#5 implementer",
        settingsPath: "/s/settings.json",
        model: { model: "sonnet", effort: "high" },
      }),
    ).toEqual([
      "--settings",
      "/s/settings.json",
      "--remote-control",
      "octo/app#5 implementer",
      "--dangerously-skip-permissions",
      "--model",
      "sonnet",
      "--effort",
      "high",
    ]);
  });

  test("REQ-001-20 resumes by Claude session id and leaves out effort when none is set", () => {
    const args = claudeArgs({ name: "n", settingsPath: "s", model: { model: "opus" }, resumeId: "abc" });
    expect(args.slice(0, 2)).toEqual(["--resume", "abc"]);
    expect(args).not.toContain("--effort");
    expect(args.at(-2)).toBe("--model");
  });

  test("REQ-001-33 names an issue's session after the issue, its Role and the repository", () => {
    expect(
      remoteControlName({ repo: "octo/app", role: "reviewer", kind: "issue", issues: [9], title: "Fix login" }),
    ).toBe("#9 Fix login · Reviewer · app");
  });

  test("REQ-001-33 a Bundle's session adds how many more issues it covers", () => {
    expect(
      remoteControlName({
        repo: "octo/app",
        role: "implementer",
        kind: "issue",
        issues: [5, 6, 7],
        title: "Dark mode",
      }),
    ).toBe("#5 Dark mode (+2) · Implementer · app");
  });

  test("REQ-001-33 a batch Planner lists its issues", () => {
    expect(
      remoteControlName({ repo: "octo/app", role: "planner", kind: "batch", issues: [1, 2, 3], title: null }),
    ).toBe("Planner · #1, #2, #3 · app");
  });

  test("REQ-001-33 truncates long titles to 50 characters with an ellipsis", () => {
    const title = `${"A".repeat(49)}BCDEF`;
    const name = remoteControlName({ repo: "octo/app", role: "planner", kind: "issue", issues: [4], title });
    expect(name).toBe(`#4 ${"A".repeat(49)}… · Planner · app`);
    expect(remoteControlName({ repo: "o/a", role: "planner", kind: "issue", issues: [4], title: "B".repeat(50) })).toBe(
      `#4 ${"B".repeat(50)} · Planner · a`,
    );
  });

  test("REQ-001-33 a session stored without a title keeps the old name", () => {
    expect(remoteControlName({ repo: "octo/app", role: "reviewer", kind: "issue", issues: [9], title: null })).toBe(
      "octo/app#9 reviewer",
    );
  });

  test("quotes arguments for the shell", () => {
    expect(shellQuote(["claude", "it's a test", "plain"])).toBe(`'claude' 'it'\\''s a test' 'plain'`);
  });
});

describe("session runner", () => {
  test("REQ-001-18 / REQ-001-17 starts a session in its own tmux window with per-session hooks (StopFailure for the usage limit), without a manual step", () => {
    const id = startImplementer();
    const win = tmux.windows.get(`s${id}`);
    expect(win?.cwd).toBe("/work/app-5");
    expect(win?.command).toContain("'--remote-control' '#5 Add dark mode · Implementer · app'");
    expect(promptOf(id)).toContain("Implement #5");
    const settings = JSON.parse(readFileSync(join(dir, "sessions", String(id), "settings.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      `'bun' '/app/src/hook.ts' 'Stop' '${join(dir, "state.db")}' '${id}' '${join(dir, "sessions", String(id))}'`,
    );
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Notification",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "StopFailure",
      "UserPromptSubmit",
    ]);
    expect(store.session(id)).toMatchObject({ state: "running", coordinatorPromptPending: true });
    expect(runner.liveSessionIds()).toEqual(new Set([id]));
  });

  const startRole = (role: "planner" | "implementer" | "reviewer") =>
    runner.start({
      repo: "octo/app",
      role,
      kind: "issue",
      issues: [5],
      cwd: "/w",
      prompt: "p",
      model: { model: "opus" },
    });
  const settingsOf = (id: number) =>
    JSON.parse(readFileSync(join(dir, "sessions", String(id), "settings.json"), "utf8"));

  test("REQ-005-01 every Role starts with permission prompts skipped and no add-dir", () => {
    for (const role of ["planner", "implementer", "reviewer"] as const) {
      const cmd = tmux.windows.get(`s${startRole(role)}`)?.command ?? "";
      expect(cmd).toContain("'--dangerously-skip-permissions'");
      expect(cmd).not.toContain("--permission-mode");
      expect(cmd).not.toContain("--allowedTools");
      expect(cmd).not.toContain("--add-dir");
      expect(cmd).not.toContain("GH_CONFIG_DIR");
    }
  });

  test("REQ-005-01 every session is started with IS_SANDBOX=1, so skipped permissions also work as root", () => {
    for (const role of ["planner", "implementer", "reviewer"] as const) {
      const id = startRole(role);
      expect(tmux.windows.get(`s${id}`)?.command).toStartWith(`${tmpEnv(id)}IS_SANDBOX=1 'claude' `);
    }
  });

  test("REQ-005-01 session settings hold only the hooks, the status line and the CLAUDE.md excludes, for every Role", () => {
    for (const role of ["planner", "implementer", "reviewer"] as const) {
      const id = startRole(role);
      expect(Object.keys(settingsOf(id))).toEqual(["hooks", "statusLine", "claudeMdExcludes"]);
      expect(existsSync(join(dir, "sessions", String(id), "gh"))).toBe(false);
    }
  });

  test("REQ-005-01 a resume rewrites the settings without permissions or sandbox", () => {
    const id = startImplementer();
    store.setAgentSessionId(id, "sess-abc");
    store.patchSession(id, { state: "idle" });
    const path = join(dir, "sessions", String(id), "settings.json");
    // A session folder written by an older Coordinator, with a sandbox and deny rules.
    writeFileSync(path, JSON.stringify({ sandbox: { enabled: true }, permissions: { deny: ["Read(//x)"] } }));
    writeFileSync(
      join(dir, "sessions", String(id), "meta.json"),
      JSON.stringify({ cwd: "/work/app-5", sandboxDomains: ["registry.npmjs.org"] }),
    );
    runner.resume(id, "more", { model: "opus" });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(settings)).toEqual(["hooks", "statusLine", "claudeMdExcludes"]);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(tmux.windows.get(`s${id}`)?.cwd).toBe("/work/app-5");
    expect(tmux.windows.get(`s${id}`)?.command).toContain("'--dangerously-skip-permissions'");
  });

  test("REQ-001-67 every session's status line runs the hook, which records the Usage quota", () => {
    const id = startRole("reviewer");
    expect(settingsOf(id).statusLine).toEqual({
      type: "command",
      command: `'bun' '/app/src/hook.ts' 'StatusLine' '${join(dir, "state.db")}' '${id}' '${join(dir, "sessions", String(id))}'`,
    });
  });

  test("REQ-005-07 a session loads no CLAUDE.md from the folders above its own", () => {
    const id = runner.start({
      repo: "octo/app",
      role: "implementer",
      kind: "issue",
      issues: [87],
      cwd: "/root/coordinator/.issueflow/worktrees/octo/app/87",
      prompt: "p",
      model: { model: "opus" },
    });
    const excludes: string[] = settingsOf(id).claudeMdExcludes;
    // The Coordinator's own checkout, whose CLAUDE.md imports AGENTS.md (#87), and every folder up to the root.
    for (const parent of ["/root/coordinator", "/root/coordinator/.issueflow/worktrees/octo/app", "/root", "/"]) {
      const at = parent === "/" ? "" : parent;
      expect(excludes).toContain(`${at}/CLAUDE.md`);
      expect(excludes).toContain(`${at}/CLAUDE.local.md`);
    }
    expect(excludes).toContain("/root/coordinator/.claude/CLAUDE.md");
    expect(excludes).toContain("/root/coordinator/.claude/rules/**");
    // The repository's own instructions still load.
    const own = "/root/coordinator/.issueflow/worktrees/octo/app/87";
    expect(excludes.filter((e) => e.startsWith(`${own}/`))).toEqual([]);
  });

  test("REQ-005-07 the Owner's own instructions in ~/.claude still load when home is above the session", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const r = new SessionRunner({
      store,
      tmux,
      stateDir: dir,
      dbPath: join(dir, "state.db"),
      hookCommand: ["bun", "/app/src/hook.ts"],
      home,
    });
    const id = r.start({
      repo: "octo/app",
      role: "planner",
      kind: "issue",
      issues: [5],
      cwd: join(home, "coordinator", ".issueflow", "worktrees", "octo", "app", "5"),
      prompt: "p",
      model: { model: "opus" },
    });
    const excludes: string[] = settingsOf(id).claudeMdExcludes;
    expect(excludes).toContain(join(home, "CLAUDE.md"));
    expect(excludes.filter((e) => e.startsWith(join(home, ".claude")))).toEqual([]);
    rmSync(home, { recursive: true });
  });

  test("REQ-005-07 a resume writes the excludes for the session's folder", () => {
    const id = startImplementer();
    store.setAgentSessionId(id, "sess-abc");
    store.patchSession(id, { state: "idle" });
    const path = join(dir, "sessions", String(id), "settings.json");
    writeFileSync(path, JSON.stringify({ hooks: {} }));
    runner.resume(id, "more", { model: "opus" });
    expect(JSON.parse(readFileSync(path, "utf8")).claudeMdExcludes).toContain("/work/CLAUDE.md");
  });

  test("the prompt tells the session where to write its Result", () => {
    const id = startImplementer();
    expect(promptOf(id)).toContain(join(dir, "sessions", String(id), "result.json"));
  });

  test("REQ-001-19 refuses to inject a prompt into, or close, a session that is running", () => {
    const id = startImplementer();
    expect(() => runner.resume(id, "more", { model: "sonnet" })).toThrow(SessionBusyError);
    expect(() => runner.close(id)).toThrow(SessionBusyError);
    expect(tmux.windows.has(`s${id}`)).toBe(true);
  });

  test("REQ-001-20 closes an idle session by killing its window", () => {
    const id = startImplementer();
    store.patchSession(id, { state: "idle" });
    runner.close(id);
    expect(tmux.windows.size).toBe(0);
    expect(store.session(id)?.state).toBe("closed");
  });

  test("REQ-001-20 / REQ-001-33 resumes a closed or idle session with --resume, its name, a fresh Result file and the new prompt", () => {
    const id = startImplementer();
    store.setAgentSessionId(id, "sess-abc");
    store.patchSession(id, {
      state: "idle",
      resultFailures: 2,
      usageLimited: true,
      usageLimitResetsAt: "2026-11-22T10:00:00.000Z",
    });
    const resultPath = join(dir, "sessions", String(id), "result.json");
    writeFileSync(resultPath, "{}");
    runner.resume(id, "Fix the review findings", { model: "opus" });
    const cmd = tmux.windows.get(`s${id}`)?.command ?? "";
    expect(cmd).toContain("'--resume' 'sess-abc'");
    expect(cmd).toContain("'--remote-control' '#5 Add dark mode · Implementer · app'");
    expect(promptOf(id)).toContain("Fix the review findings");
    expect(existsSync(resultPath)).toBe(false);
    expect(store.session(id)).toMatchObject({
      state: "running",
      coordinatorPromptPending: true,
      resultFailures: 0,
      usageLimited: false,
      usageLimitResetsAt: null,
    });
    store.patchSession(id, { state: "closed" });
    tmux.windows.clear();
    runner.resume(id, "again", { model: "opus" });
    expect(runner.liveSessionIds()).toEqual(new Set([id]));
  });

  test("REQ-001-16 a session still marked running whose window is gone (interrupted) can be resumed and closed", () => {
    const id = startImplementer();
    store.setAgentSessionId(id, "sess-abc");
    tmux.windows.clear();
    runner.resume(id, "Continue", { model: "opus" });
    expect(runner.liveSessionIds()).toEqual(new Set([id]));
    tmux.windows.clear();
    runner.close(id);
    expect(store.session(id)?.state).toBe("closed");
  });

  test("REQ-001-24 a wake keeps the existing Result file", () => {
    const id = startImplementer();
    store.setAgentSessionId(id, "sess-abc");
    store.patchSession(id, { state: "idle" });
    const resultPath = join(dir, "sessions", String(id), "result.json");
    writeFileSync(resultPath, "{}");
    runner.resume(id, "The Owner wants to chat", { model: "opus" }, { keepResult: true });
    expect(existsSync(resultPath)).toBe(true);
    expect(promptOf(id)).toStartWith("The Owner wants to chat");
    expect(promptOf(id)).not.toContain("Before ending your turn, write your Result");
  });

  test("a session that never reported its id cannot be resumed", () => {
    const id = startImplementer();
    store.patchSession(id, { state: "idle" });
    expect(() => runner.resume(id, "x", { model: "opus" })).toThrow("no Claude session id");
  });

  test("answers the folder trust dialog in new folders", () => {
    const id = startImplementer();
    const win = tmux.windows.get(`s${id}`);
    if (win) win.pane = "Is this a project you created or one you trust?\n❯ 1. No, exit\n  2. Yes, I trust this folder";
    runner.answerDialogs();
    expect(tmux.keys).toEqual([
      [`s${id}`, ["Down"]],
      [`s${id}`, ["Enter"]],
    ]);
  });

  /** Claude Code's one-time warning before it runs with skipped permissions; "No, exit" comes first and has focus. */
  const bypassScreen = [
    " WARNING: Claude Code running in Bypass Permissions mode",
    "",
    " In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.",
    "",
    " ❯ 1. No, exit",
    "   2. Yes, I accept",
  ].join("\n");

  test("REQ-005-01 accepts the Bypass Permissions warning", () => {
    const id = startImplementer();
    const win = tmux.windows.get(`s${id}`);
    if (win) win.pane = bypassScreen;
    runner.answerDialogs();
    expect(tmux.keys).toEqual([
      [`s${id}`, ["Down"]],
      [`s${id}`, ["Enter"]],
    ]);
  });

  test("REQ-001-57 leaves any other screen unanswered", () => {
    const id = startImplementer();
    const win = tmux.windows.get(`s${id}`);
    if (win) win.pane = " Adding a new directory:\n\n /somewhere\n\n ❯ No, exit\n   Yes, add it";
    runner.answerDialogs();
    expect(tmux.keys).toEqual([]);
  });

  test("REQ-001-57 a session that did not start can be abandoned: its window is closed and it is recorded closed", () => {
    const id = startImplementer();
    const win = tmux.windows.get(`s${id}`);
    if (win) win.pane = "  some screen  \n\n";
    expect(runner.screen(id)).toBe("  some screen  \n\n");
    runner.abandon(id);
    expect(runner.liveSessionIds().has(id)).toBe(false);
    expect(store.session(id)).toMatchObject({ state: "closed", coordinatorPromptPending: false });
  });

  test("REQ-001-45 a long prompt reaches claude in full, as one argument, without shell interpretation", () => {
    // tmux refuses commands over about 16 KB ("command too long"); untrusted issue text must not be run.
    const tricky = `it's "quoted" $(touch pwned) \`touch pwned\` $HOME \\ ; | & \n`;
    const prompt = `${tricky}${"x".repeat(64 * 1024)}\n${tricky}`;
    const id = runner.start({
      repo: "octo/app",
      role: "planner",
      kind: "issue",
      issues: [41],
      cwd: dir,
      prompt,
      model: { model: "opus" },
    });
    const command = tmux.windows.get(`s${id}`)?.command ?? "";
    expect(command.length).toBeLessThan(4_000);

    // Run the command line in a real shell, with a stand-in for claude that records its arguments.
    const fake = join(dir, "fake-claude");
    writeFileSync(fake, `#!/bin/sh\nfor a; do last=$a; done\nprintf '%s' "$last" > "${dir}/last"\n`);
    chmodSync(fake, 0o755);
    const p = Bun.spawnSync(["sh", "-c", command.replace("'claude'", shellQuote([fake]))], { cwd: dir });
    expect(p.exitCode).toBe(0);
    // One argument: a prompt split by the shell would leave only its last word here.
    expect(readFileSync(join(dir, "last"), "utf8")).toBe(promptOf(id));
    expect(promptOf(id)).toStartWith(prompt);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  test("REQ-001-44 a session that cannot be launched is recorded as closed, with the launch error", () => {
    tmux.failWith = "tmux new-window failed: command too long";
    let error: unknown;
    try {
      startImplementer();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SessionStartError);
    expect((error as SessionStartError).message).toContain("tmux new-window failed: command too long");
    const s = (error as SessionStartError).session;
    expect(s).toMatchObject({ repo: "octo/app", role: "implementer", issues: [5] });
    expect(store.session(s.id)).toMatchObject({ state: "closed", coordinatorPromptPending: false });
    expect(store.sessions("octo/app")).toEqual([]);
  });

  test("REQ-001-44 a session that cannot be relaunched on resume is recorded as closed, with the launch error", () => {
    const id = startImplementer();
    store.setAgentSessionId(id, "sess-abc");
    store.patchSession(id, { state: "idle" });
    tmux.failWith = "tmux new-window failed: command too long";
    expect(() => runner.resume(id, "more", { model: "opus" })).toThrow(SessionStartError);
    expect(store.session(id)?.state).toBe("closed");
    // Refusals before any launch are not start failures.
    tmux.failWith = null;
    const busy = startImplementer();
    expect(() => runner.resume(busy, "more", { model: "opus" })).toThrow(SessionBusyError);
    expect(store.session(busy)?.state).toBe("running");
  });

  describe("REQ-001-62 each session has its own temp folder", () => {
    test("a started session (of any Role, see REQ-005-01) gets TMPDIR and CLAUDE_CODE_TMPDIR inside its session folder, and the folder exists", () => {
      const id = startImplementer();
      expect(tmux.windows.get(`s${id}`)?.command).toStartWith(tmpEnv(id));
      expect(existsSync(tmpOf(id))).toBe(true);
    });

    test("a resumed session gets them again, with the folder recreated after a close", () => {
      const id = startImplementer();
      store.setAgentSessionId(id, "sess-abc");
      store.patchSession(id, { state: "idle" });
      runner.close(id);
      runner.resume(id, "Fix the review findings", { model: "opus" });
      expect(tmux.windows.get(`s${id}`)?.command).toStartWith(tmpEnv(id));
      expect(existsSync(tmpOf(id))).toBe(true);
    });

    test("closing a session deletes its temp folder, but keeps the Result and meta.json", () => {
      const id = startImplementer();
      mkdirSync(join(tmpOf(id), "chrome-profile"), { recursive: true });
      writeFileSync(join(tmpOf(id), "chrome-profile", "Cookies"), "x");
      const sessionFolder = join(dir, "sessions", String(id));
      writeFileSync(join(sessionFolder, "result.json"), "{}");
      store.patchSession(id, { state: "idle" });
      runner.close(id);
      expect(existsSync(tmpOf(id))).toBe(false);
      expect(existsSync(join(sessionFolder, "result.json"))).toBe(true);
      expect(existsSync(join(sessionFolder, "meta.json"))).toBe(true);
    });

    test("an abandoned session (REQ-001-57) and one whose launch failed (REQ-001-44) lose their temp folder too", () => {
      const id = startImplementer();
      expect(existsSync(tmpOf(id))).toBe(true);
      runner.abandon(id);
      expect(existsSync(tmpOf(id))).toBe(false);
      tmux.failWith = "tmux new-window failed";
      let error: unknown;
      try {
        startImplementer();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SessionStartError);
      const failed = (error as SessionStartError).session.id;
      expect(existsSync(join(dir, "sessions", String(failed), "meta.json"))).toBe(true);
      expect(existsSync(tmpOf(failed))).toBe(false);
    });
  });

  test("ignores tmux windows it does not own", () => {
    tmux.newWindow("keepalive", "/", "sleep");
    tmux.newWindow("s12x", "/", "sleep");
    expect(runner.liveSessionIds()).toEqual(new Set());
  });
});

describe("Accounts", () => {
  let accountsRunner: SessionRunner;
  let home: string;
  const spareDir = () => join(home, ".claude-spare");
  beforeEach(() => {
    home = join(dir, "home");
    accountsRunner = new SessionRunner({
      store,
      tmux,
      stateDir: dir,
      dbPath: join(dir, "state.db"),
      hookCommand: ["bun", "/app/src/hook.ts"],
      accounts: [{ name: "main" }, { name: "spare", configDir: join(dir, "home", ".claude-spare") }],
      home,
    });
  });
  const start = () =>
    accountsRunner.start({
      repo: "octo/app",
      role: "planner",
      kind: "issue",
      issues: [5],
      cwd: "/work/app",
      prompt: "p",
      model: { model: "opus" },
    });
  const commandOf = (id: number) => tmux.windows.get(`s${id}`)?.command ?? "";

  test("REQ-004-01 a session starts on the first Account, in Claude's default folder, and records it", () => {
    const id = start();
    expect(commandOf(id)).toStartWith(`${tmpEnv(id)}IS_SANDBOX=1 'claude' `);
    expect(commandOf(id)).not.toContain("CLAUDE_CONFIG_DIR");
    expect(store.session(id)?.account).toBe("main");
  });

  test("REQ-004-01 / REQ-001-17 while the first Account is paused, sessions start on the next one with its folder", () => {
    store.setPausedUntil("main", new Date(Date.now() + 60_000).toISOString());
    const id = start();
    expect(commandOf(id)).toStartWith(
      `${tmpEnv(id)}IS_SANDBOX=1 CLAUDE_CONFIG_DIR=${shellQuote([spareDir()])} 'claude' `,
    );
    expect(store.session(id)?.account).toBe("spare");
  });

  test("REQ-001-17 a session resumed on another Account takes its transcript along", () => {
    const id = start();
    store.setAgentSessionId(id, "c1");
    store.patchSession(id, { state: "idle", usageLimited: true });
    const project = join(home, ".claude", "projects", "-work-app");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "c1.jsonl"), "turns\n");
    store.setPausedUntil("main", new Date(Date.now() + 60_000).toISOString());

    accountsRunner.resume(id, "go on", { model: "opus" });
    expect(commandOf(id)).toStartWith(
      `${tmpEnv(id)}IS_SANDBOX=1 CLAUDE_CONFIG_DIR=${shellQuote([spareDir()])} 'claude' '--resume' 'c1'`,
    );
    expect(store.session(id)?.account).toBe("spare");
    expect(readFileSync(join(spareDir(), "projects", "-work-app", "c1.jsonl"), "utf8")).toBe("turns\n");

    // Back on the first Account once its pause is over: the transcript comes back with the new turns.
    writeFileSync(join(spareDir(), "projects", "-work-app", "c1.jsonl"), "turns\nmore turns\n");
    store.setPausedUntil("main", undefined);
    store.patchSession(id, { state: "idle" });
    accountsRunner.resume(id, "again", { model: "opus" });
    expect(store.session(id)?.account).toBe("main");
    expect(readFileSync(join(project, "c1.jsonl"), "utf8")).toBe("turns\nmore turns\n");
  });
});

describe("Harnesses (spec 006)", () => {
  let home: string;
  let multi: SessionRunner;
  const codexHome = () => join(home, ".codex-gpt");
  beforeEach(() => {
    home = join(dir, "home");
    multi = new SessionRunner({
      store,
      tmux,
      stateDir: dir,
      dbPath: join(dir, "state.db"),
      hookCommand: ["bun", "/app/src/hook.ts"],
      accounts: [
        { name: "main" },
        { name: "gpt", harness: "codex", configDir: join(dir, "home", ".codex-gpt") },
        { name: "gpt2", harness: "codex" },
      ],
      home,
    });
  });
  const start = (model: string) =>
    multi.start({
      repo: "octo/app",
      role: "reviewer",
      kind: "issue",
      issues: [5],
      cwd: "/work/app",
      prompt: "p",
      model: { model },
    });
  const commandOf = (id: number) => tmux.windows.get(`s${id}`)?.command ?? "";

  test("REQ-006-01 a Codex model starts `codex` on the first Codex Account, with its folder and the hooks", () => {
    const id = start("gpt-6.2-sol");
    const cmd = commandOf(id);
    expect(cmd).toStartWith(`TMPDIR=${shellQuote([tmpOf(id)])} CODEX_HOME=${shellQuote([codexHome()])} 'codex' `);
    expect(cmd).toContain("'--dangerously-bypass-approvals-and-sandbox'");
    expect(cmd).toContain("'--model' 'gpt-6.2-sol'");
    expect(cmd).toContain(`hooks.Stop=[{hooks=[{type="command",command=`);
    expect(cmd).not.toContain("IS_SANDBOX");
    expect(store.session(id)).toMatchObject({ harness: "codex", account: "gpt" });
  });

  test("REQ-006-01 a Claude model still starts `claude` on the first Claude Account", () => {
    const id = start("opus");
    expect(commandOf(id)).toStartWith(`${tmpEnv(id)}IS_SANDBOX=1 'claude' `);
    expect(store.session(id)).toMatchObject({ harness: "claude", account: "main" });
  });

  test("REQ-006-02 a usage limit pauses only that Account: the next Codex Account takes over, in Codex's default folder", () => {
    store.setPausedUntil("gpt", new Date(Date.now() + 60_000).toISOString());
    const id = start("gpt-6.2-sol");
    expect(commandOf(id)).not.toContain("CODEX_HOME");
    expect(store.session(id)?.account).toBe("gpt2");
  });

  test("REQ-006-02 a Harness without an Account cannot start a session", () => {
    const only = new SessionRunner({
      store,
      tmux,
      stateDir: dir,
      dbPath: join(dir, "state.db"),
      hookCommand: ["bun", "/app/src/hook.ts"],
    });
    expect(() =>
      only.start({
        repo: "octo/app",
        role: "reviewer",
        kind: "issue",
        issues: [5],
        cwd: "/w",
        prompt: "p",
        model: { model: "gpt-5.5" },
      }),
    ).toThrow("no Account of Codex CLI");
  });

  test("REQ-006-03 a resume stays on the session's Harness, even after its Role's model moved to another one", () => {
    const id = start("gpt-6.2-sol");
    store.setAgentSessionId(id, "01a1f4fb");
    store.patchSession(id, { state: "idle" });
    multi.resume(id, "go on", { model: "opus" });
    const cmd = commandOf(id);
    expect(cmd).toContain("'codex' 'resume' '01a1f4fb'");
    expect(cmd).toContain("'--model' 'opus'");
  });

  test("REQ-006-04 / REQ-001-17 a Codex turn that ended on the usage limit without a Stop hook is marked", () => {
    const id = start("gpt-6.2-sol");
    store.patchSession(id, { coordinatorPromptPending: false });
    store.setTranscriptPath(id, join(import.meta.dir, "fixtures", "codex", "rollout-usage-limit.jsonl"));
    const claudeId = start("opus");
    store.patchSession(claudeId, { coordinatorPromptPending: false });
    store.setTranscriptPath(claudeId, join(import.meta.dir, "fixtures", "codex", "rollout-usage-limit.jsonl"));
    expect(multi.detectEndedTurns()).toEqual([id]);
    expect(store.session(id)).toMatchObject({ state: "idle", usageLimited: true, usageLimitResetsAt: null });
    expect(store.session(claudeId)?.state).toBe("running");
  });

  test("REQ-006-07 a Gemini model starts `agy` with its session settings and hooks, in the default folder", () => {
    const agy = new SessionRunner({
      store,
      tmux,
      stateDir: dir,
      dbPath: join(dir, "state.db"),
      hookCommand: ["bun", "/app/src/hook.ts"],
      accounts: [{ name: "main" }, { name: "gemini", harness: "antigravity" }],
      home,
    });
    const id = agy.start({
      repo: "octo/app",
      role: "reviewer",
      kind: "issue",
      issues: [5],
      cwd: "/work/app",
      prompt: "p",
      model: { model: "gemini-4-neon", effort: "high" },
    });
    const cmd = commandOf(id);
    const sessionDir = join(dir, "sessions", String(id));
    expect(cmd).toStartWith(`TMPDIR=${shellQuote([tmpOf(id)])} 'agy' '--settings' `);
    expect(cmd).toContain(`'--add-dir' ${shellQuote([sessionDir])} '--dangerously-skip-permissions'`);
    expect(cmd).toContain("'--model' 'gemini-4-neon' '--effort' 'high' '-i' \"$(cat ");
    expect(readFileSync(join(sessionDir, ".agents", "hooks.json"), "utf8")).toContain("'Stop'");
    expect(store.session(id)).toMatchObject({ harness: "antigravity", account: "gemini" });

    store.setAgentSessionId(id, "955778c7");
    store.patchSession(id, { state: "idle" });
    agy.resume(id, "go on", { model: "gemini-4-neon" });
    expect(commandOf(id)).toContain("'agy' '--conversation' '955778c7' '--settings' ");
  });

  test("REQ-006-14 an `opencode:` model starts `opencode --mini` with its session's config folder; a resume takes its id", () => {
    const oc = new SessionRunner({
      store,
      tmux,
      stateDir: dir,
      dbPath: join(dir, "state.db"),
      hookCommand: ["bun", "/app/src/hook.ts"],
      accounts: [{ name: "main" }, { name: "zen", harness: "opencode" }],
      home,
    });
    const id = oc.start({
      repo: "octo/app",
      role: "reviewer",
      kind: "issue",
      issues: [5],
      cwd: "/work/app",
      prompt: "p",
      model: { model: "opencode:opencode/big-pickle", effort: "high" },
    });
    const configDir = join(dir, "sessions", String(id), "opencode");
    expect(commandOf(id)).toStartWith(
      `TMPDIR=${shellQuote([tmpOf(id)])} OPENCODE_CONFIG_DIR=${shellQuote([configDir])} 'opencode' '--mini' '--auto' `,
    );
    expect(commandOf(id)).toContain("'--model' 'opencode/big-pickle' '--prompt' \"$(cat ");
    expect(readFileSync(join(configDir, "plugins", "issueflow.js"), "utf8")).toContain("'Stop'");
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8")).agent.build.variant).toBe("high");
    expect(store.session(id)).toMatchObject({ harness: "opencode", account: "zen" });

    store.setAgentSessionId(id, "ses_e06d8aa75ffeTJsuqaLTkpifOS");
    store.patchSession(id, { state: "idle" });
    oc.resume(id, "go on", { model: "opencode:opencode/big-pickle" });
    expect(commandOf(id)).toContain("'opencode' '--session' 'ses_e06d8aa75ffeTJsuqaLTkpifOS' '--mini' ");
    // The resume's model has no effort: the session's config no longer sets a variant.
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8")).agent).toBeUndefined();
  });

  test("REQ-006-01 the Codex trust dialog is answered with Enter", () => {
    const id = start("gpt-6.2-sol");
    const w = tmux.windows.get(`s${id}`);
    if (w) w.pane = "Trust this folder? Codex can read, edit…\n› 1. Trust and continue\n  2. Back";
    multi.answerDialogs();
    expect(tmux.keys).toEqual([[`s${id}`, ["Enter"]]]);
  });
});

describe("Copilot CLI (spec 006, #176)", () => {
  let home: string;
  let runner: SessionRunner;
  const copilotHome = () => join(home, ".copilot-work");
  beforeEach(() => {
    home = join(dir, "home");
    runner = new SessionRunner({
      store,
      tmux,
      stateDir: dir,
      dbPath: join(dir, "state.db"),
      hookCommand: ["bun", "/app/src/hook.ts"],
      accounts: [
        { name: "main" },
        { name: "work", harness: "copilot", configDir: join(dir, "home", ".copilot-work") },
        { name: "personal", harness: "copilot" },
      ],
      home,
    });
  });
  const start = (model: string, effort?: "high") =>
    runner.start({
      repo: "octo/app",
      role: "implementer",
      kind: "issue",
      issues: [5],
      cwd: "/work/app",
      prompt: "p",
      model: { model, effort },
    });
  const commandOf = (id: number) => tmux.windows.get(`s${id}`)?.command ?? "";
  const pluginDir = (id: number) => join(dir, "sessions", String(id), "copilot-plugin");

  test("REQ-006-10 a `copilot:` model starts `copilot` interactively on the first Copilot Account, all tools allowed", () => {
    const id = start("copilot:claude-sonnet-5.5", "high");
    const cmd = commandOf(id);
    expect(cmd).toStartWith(
      `TMPDIR=${shellQuote([tmpOf(id)])} COPILOT_ALLOW_ALL=true COPILOT_HOME=${shellQuote([copilotHome()])} 'copilot' `,
    );
    expect(cmd).toContain(`'--plugin-dir' ${shellQuote([pluginDir(id)])} '--allow-all'`);
    // The Harness's own model name, without the catalogue's `copilot:` prefix.
    expect(cmd).toContain("'--model' 'claude-sonnet-5.5' '--reasoning-effort' 'high'");
    // `-i` starts an interactive session with the prompt, which the runner appends last.
    expect(cmd).toMatch(/'-i' "\$\(cat '[^']+prompt\.md'\)"$/);
    expect(store.session(id)).toMatchObject({ harness: "copilot", account: "work" });
  });

  test("REQ-006-10 the hooks are a plugin in the session folder, never in the Worktree or the Account's folder", () => {
    const id = start("copilot:gpt-6.1-sol");
    const manifest = JSON.parse(readFileSync(join(pluginDir(id), ".plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBeTruthy();
    const hooks = JSON.parse(readFileSync(join(pluginDir(id), "hooks", "hooks.json"), "utf8")).hooks;
    const hook = (ev: string) => expect.stringMatching(new RegExp(`^'bun' '/app/src/hook\\.ts' '${ev}' `));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"])
      expect(hooks[ev][0].hooks[0]).toEqual({ type: "command", command: hook(ev) });
    // REQ-006-12: Copilot's own event for a failed model call, in Copilot's own format.
    expect(hooks.errorOccurred[0]).toEqual({ type: "command", bash: hook("errorOccurred") });
    expect(existsSync(join(copilotHome(), "hooks"))).toBe(false);
  });

  test("REQ-006-11 Feedback resumes the same Copilot session by its id, never the latest one", () => {
    const id = start("copilot:gpt-6.1-sol");
    store.setAgentSessionId(id, "29ca2f8f-d225-47ac-829b-bc8e93ce5e41");
    store.patchSession(id, { state: "idle" });
    runner.resume(id, "feedback", { model: "copilot:gpt-6.1-sol" });
    const cmd = commandOf(id);
    expect(cmd).toContain("'copilot' '--resume' '29ca2f8f-d225-47ac-829b-bc8e93ce5e41' ");
    expect(cmd).not.toContain("--continue");
  });

  test("REQ-006-11 / REQ-001-17 a resume on another Account takes the session's folder along", () => {
    const id = start("copilot:gpt-6.1-sol");
    const sid = "29ca2f8f-d225-47ac-829b-bc8e93ce5e41";
    store.setAgentSessionId(id, sid);
    mkdirSync(join(copilotHome(), "session-state", sid), { recursive: true });
    writeFileSync(join(copilotHome(), "session-state", sid, "events.jsonl"), "turns\n");
    store.setPausedUntil("work", new Date(Date.now() + 60_000).toISOString());
    store.patchSession(id, { state: "idle" });
    runner.resume(id, "go on", { model: "copilot:gpt-6.1-sol" });
    expect(store.session(id)?.account).toBe("personal");
    expect(commandOf(id)).not.toContain("COPILOT_HOME");
    expect(readFileSync(join(home, ".copilot", "session-state", sid, "events.jsonl"), "utf8")).toBe("turns\n");
  });
});
