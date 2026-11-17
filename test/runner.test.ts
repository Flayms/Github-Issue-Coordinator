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
  test("REQ-001-18 starts a session in its own tmux window with per-session hooks, without a manual step", () => {
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
    for (const role of ["planner", "implementer", "reviewer"] as const)
      expect(tmux.windows.get(`s${startRole(role)}`)?.command).toStartWith("IS_SANDBOX=1 'claude' ");
  });

  test("REQ-005-01 session settings hold only the hooks and the CLAUDE.md excludes, for every Role", () => {
    for (const role of ["planner", "implementer", "reviewer"] as const) {
      const id = startRole(role);
      expect(Object.keys(settingsOf(id))).toEqual(["hooks", "claudeMdExcludes"]);
      expect(existsSync(join(dir, "sessions", String(id), "gh"))).toBe(false);
    }
  });

  test("REQ-005-01 a resume rewrites the settings without permissions or sandbox", () => {
    const id = startImplementer();
    store.setClaudeSessionId(id, "sess-abc");
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
    expect(Object.keys(settings)).toEqual(["hooks", "claudeMdExcludes"]);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(tmux.windows.get(`s${id}`)?.cwd).toBe("/work/app-5");
    expect(tmux.windows.get(`s${id}`)?.command).toContain("'--dangerously-skip-permissions'");
  });

  test("REQ-005-07 a session loads no CLAUDE.md from the folders above its own", () => {
    const id = runner.start({
      repo: "octo/app",
      role: "implementer",
      kind: "issue",
      issues: [87],
      cwd: "/root/coordinator/.coordinator/worktrees/octo/app/87",
      prompt: "p",
      model: { model: "opus" },
    });
    const excludes: string[] = settingsOf(id).claudeMdExcludes;
    // The Coordinator's own checkout, whose CLAUDE.md imports AGENTS.md (#87), and every folder up to the root.
    for (const parent of ["/root/coordinator", "/root/coordinator/.coordinator/worktrees/octo/app", "/root", "/"]) {
      const at = parent === "/" ? "" : parent;
      expect(excludes).toContain(`${at}/CLAUDE.md`);
      expect(excludes).toContain(`${at}/CLAUDE.local.md`);
    }
    expect(excludes).toContain("/root/coordinator/.claude/CLAUDE.md");
    expect(excludes).toContain("/root/coordinator/.claude/rules/**");
    // The repository's own instructions still load.
    const own = "/root/coordinator/.coordinator/worktrees/octo/app/87";
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
      cwd: join(home, "coordinator", ".coordinator", "worktrees", "octo", "app", "5"),
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
    store.setClaudeSessionId(id, "sess-abc");
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
    store.setClaudeSessionId(id, "sess-abc");
    store.patchSession(id, { state: "idle", resultFailures: 2, usageLimited: true });
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
    });
    store.patchSession(id, { state: "closed" });
    tmux.windows.clear();
    runner.resume(id, "again", { model: "opus" });
    expect(runner.liveSessionIds()).toEqual(new Set([id]));
  });

  test("REQ-001-16 a session still marked running whose window is gone (interrupted) can be resumed and closed", () => {
    const id = startImplementer();
    store.setClaudeSessionId(id, "sess-abc");
    tmux.windows.clear();
    runner.resume(id, "Continue", { model: "opus" });
    expect(runner.liveSessionIds()).toEqual(new Set([id]));
    tmux.windows.clear();
    runner.close(id);
    expect(store.session(id)?.state).toBe("closed");
  });

  test("REQ-001-24 a wake keeps the existing Result file", () => {
    const id = startImplementer();
    store.setClaudeSessionId(id, "sess-abc");
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
    store.setClaudeSessionId(id, "sess-abc");
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
    expect(commandOf(id)).toStartWith("IS_SANDBOX=1 'claude' ");
    expect(commandOf(id)).not.toContain("CLAUDE_CONFIG_DIR");
    expect(store.session(id)?.account).toBe("main");
  });

  test("REQ-004-01 / REQ-001-17 while the first Account is paused, sessions start on the next one with its folder", () => {
    store.setPausedUntil("main", new Date(Date.now() + 60_000).toISOString());
    const id = start();
    expect(commandOf(id)).toStartWith(`IS_SANDBOX=1 CLAUDE_CONFIG_DIR=${shellQuote([spareDir()])} 'claude' `);
    expect(store.session(id)?.account).toBe("spare");
  });

  test("REQ-001-17 a session resumed on another Account takes its transcript along", () => {
    const id = start();
    store.setClaudeSessionId(id, "c1");
    store.patchSession(id, { state: "idle", usageLimited: true });
    const project = join(home, ".claude", "projects", "-work-app");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "c1.jsonl"), "turns\n");
    store.setPausedUntil("main", new Date(Date.now() + 60_000).toISOString());

    accountsRunner.resume(id, "go on", { model: "opus" });
    expect(commandOf(id)).toStartWith(
      `IS_SANDBOX=1 CLAUDE_CONFIG_DIR=${shellQuote([spareDir()])} 'claude' '--resume' 'c1'`,
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
