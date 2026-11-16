import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    secretPaths: ["/home/agent/.config/coordinator", "/home/agent/.claude/.credentials.json"],
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
    sandboxDomains: ["registry.npmjs.org"],
  });

describe("claude command line", () => {
  test("REQ-001-18 / REQ-001-22 registers with Remote Control under its name, with model, effort and hooks; a single-value flag last", () => {
    expect(
      claudeArgs({
        name: "octo/app#5 implementer",
        settingsPath: "/s/settings.json",
        addDir: "/s",
        model: { model: "sonnet", effort: "high" },
        permissions: { permissionMode: "dontAsk", allowedTools: ["Read", "Bash(git log:*)"], sandbox: false },
      }),
    ).toEqual([
      "--add-dir",
      "/s",
      "--settings",
      "/s/settings.json",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--allowedTools",
      "Read",
      "Bash(git log:*)",
      "--remote-control",
      "octo/app#5 implementer",
      "--permission-mode",
      "dontAsk",
    ]);
  });

  test("REQ-001-20 resumes by Claude session id and leaves out effort when none is set", () => {
    const args = claudeArgs({
      name: "n",
      settingsPath: "s",
      addDir: "d",
      model: { model: "opus" },
      permissions: { permissionMode: "auto", allowedTools: [], sandbox: true },
      resumeId: "abc",
    });
    expect(args.slice(0, 2)).toEqual(["--resume", "abc"]);
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--allowedTools");
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

  test("REQ-001-25 the Implementer runs in auto mode in the sandbox; a Reviewer in dontAsk with its allowed tools", () => {
    const impl = startImplementer();
    expect(tmux.windows.get(`s${impl}`)?.command).toContain("'--permission-mode' 'auto'");
    const implSettings = JSON.parse(readFileSync(join(dir, "sessions", String(impl), "settings.json"), "utf8"));
    // REQ-001-25: never fall back to unsandboxed Bash (e.g. when a sandbox dependency is missing).
    expect(implSettings.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: ["/home/agent/.config/coordinator", "/home/agent/.claude/.credentials.json"] },
      network: { allowedDomains: ["registry.npmjs.org"] },
    });

    const rev = runner.start({
      repo: "octo/app",
      role: "reviewer",
      kind: "issue",
      issues: [9],
      cwd: "/work/review-9",
      prompt: "Review #9",
      model: { model: "opus" },
    });
    const cmd = tmux.windows.get(`s${rev}`)?.command ?? "";
    expect(cmd).toContain("'--permission-mode' 'dontAsk'");
    expect(cmd).toContain(`'Write(/${join(dir, "sessions", String(rev), "result.json")})'`);
    const revSettings = JSON.parse(readFileSync(join(dir, "sessions", String(rev), "settings.json"), "utf8"));
    expect(revSettings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      network: { allowedDomains: [] },
    });
  });

  test("REQ-001-26 every Role is denied reading the Coordinator's secrets, with file tools and in shell commands", () => {
    for (const role of ["planner", "implementer", "reviewer"] as const) {
      const id = runner.start({
        repo: "octo/app",
        role,
        kind: "issue",
        issues: [5],
        cwd: "/w",
        prompt: "p",
        model: { model: "opus" },
      });
      const settings = JSON.parse(readFileSync(join(dir, "sessions", String(id), "settings.json"), "utf8"));
      expect(settings.permissions.deny).toEqual([
        "Read(//home/agent/.config/coordinator)",
        "Read(//home/agent/.config/coordinator/**)",
        "Read(//home/agent/.claude/.credentials.json)",
        "Read(//home/agent/.claude/.credentials.json/**)",
      ]);
      expect(settings.sandbox.filesystem.denyRead).toEqual([
        "/home/agent/.config/coordinator",
        "/home/agent/.claude/.credentials.json",
      ]);
    }
  });

  test("REQ-001-30 an Implementer's shell commands may write only to its Worktree and session folder", () => {
    const impl = startImplementer();
    const cmd = tmux.windows.get(`s${impl}`)?.command ?? "";
    expect(tmux.windows.get(`s${impl}`)?.cwd).toBe("/work/app-5");
    // The sandbox makes the working directory and every --add-dir writable, nothing else.
    expect(cmd).toContain(`'--add-dir' '${join(dir, "sessions", String(impl))}'`);
    expect(cmd.match(/'--add-dir'/g)).toHaveLength(1);
    const settings = JSON.parse(readFileSync(join(dir, "sessions", String(impl), "settings.json"), "utf8"));
    expect(settings.sandbox.filesystem.allowWrite).toBeUndefined();
    expect(settings.permissions.additionalDirectories).toBeUndefined();
  });

  test("REQ-001-25 a Planner's and a Reviewer's shell commands can't write to their cwd; the Implementer's can", () => {
    // `git log/show/diff --output=<file>` writes files, so read-only git alone doesn't keep them read-only (#23).
    for (const [role, cwd] of [
      ["planner", "/clones/octo/app"],
      ["reviewer", "/reviews/octo/app/9"],
    ] as const) {
      const id = runner.start({
        repo: "octo/app",
        role,
        kind: "issue",
        issues: [9],
        cwd,
        prompt: "p",
        model: { model: "opus" },
      });
      const settings = JSON.parse(readFileSync(join(dir, "sessions", String(id), "settings.json"), "utf8"));
      expect(settings.sandbox.filesystem.denyWrite).toEqual([cwd]);
    }
    const impl = startImplementer();
    const settings = JSON.parse(readFileSync(join(dir, "sessions", String(impl), "settings.json"), "utf8"));
    expect(settings.sandbox.filesystem.denyWrite).toBeUndefined();
  });

  test("REQ-001-25 a resumed session keeps its Role's permissions", () => {
    const id = startImplementer();
    store.setClaudeSessionId(id, "sess-abc");
    store.patchSession(id, { state: "idle" });
    runner.resume(id, "more", { model: "opus" });
    expect(tmux.windows.get(`s${id}`)?.command).toContain("'--permission-mode' 'auto'");
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
