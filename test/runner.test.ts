import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, remoteControlName, SessionBusyError, SessionRunner, shellQuote } from "../src/runner.ts";
import { Store } from "../src/store.ts";
import type { Tmux } from "../src/tmux.ts";

class FakeTmux implements Tmux {
  windows = new Map<string, { cwd: string; command: string; pane: string }>();
  keys: [string, string[]][] = [];
  listWindows() {
    return [...this.windows.keys()];
  }
  newWindow(name: string, cwd: string, command: string) {
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

const startImplementer = () =>
  runner.start({
    repo: "octo/app",
    role: "implementer",
    kind: "issue",
    issues: [5],
    cwd: "/work/app-5",
    prompt: "Implement #5",
    model: { model: "sonnet", effort: "high" },
    sandboxDomains: ["registry.npmjs.org"],
  });

describe("claude command line", () => {
  test("REQ-001-18 / REQ-001-22 registers with Remote Control under its name, with model, effort and hooks; prompt last", () => {
    expect(
      claudeArgs({
        name: "octo/app#5 implementer",
        prompt: "Do it",
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
      "Do it",
    ]);
  });

  test("REQ-001-20 resumes by Claude session id and leaves out effort when none is set", () => {
    const args = claudeArgs({
      name: "n",
      prompt: "p",
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

  test("REQ-001-18 names sessions <repo>#<issue> <role>, and a batch Planner <repo> planner", () => {
    expect(remoteControlName({ repo: "octo/app", role: "reviewer", kind: "issue", issues: [9] })).toBe(
      "octo/app#9 reviewer",
    );
    expect(remoteControlName({ repo: "octo/app", role: "planner", kind: "batch", issues: [1, 2] })).toBe(
      "octo/app planner",
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
    expect(win?.command).toContain("'--remote-control' 'octo/app#5 implementer'");
    expect(win?.command).toContain("Implement #5");
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

  test("REQ-001-25 a resumed session keeps its Role's permissions", () => {
    const id = startImplementer();
    store.setClaudeSessionId(id, "sess-abc");
    store.patchSession(id, { state: "idle" });
    runner.resume(id, "more", { model: "opus" });
    expect(tmux.windows.get(`s${id}`)?.command).toContain("'--permission-mode' 'auto'");
  });

  test("the prompt tells the session where to write its Result", () => {
    const id = startImplementer();
    expect(tmux.windows.get(`s${id}`)?.command).toContain(join(dir, "sessions", String(id), "result.json"));
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

  test("REQ-001-20 resumes a closed or idle session with --resume, a fresh Result file and the new prompt", () => {
    const id = startImplementer();
    store.setClaudeSessionId(id, "sess-abc");
    store.patchSession(id, { state: "idle", resultFailures: 2, usageLimited: true });
    const resultPath = join(dir, "sessions", String(id), "result.json");
    writeFileSync(resultPath, "{}");
    runner.resume(id, "Fix the review findings", { model: "opus" });
    const cmd = tmux.windows.get(`s${id}`)?.command ?? "";
    expect(cmd).toContain("'--resume' 'sess-abc'");
    expect(cmd).toContain("Fix the review findings");
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
    expect(tmux.windows.get(`s${id}`)?.command).not.toContain("Before ending your turn, write your Result");
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

  test("ignores tmux windows it does not own", () => {
    tmux.newWindow("keepalive", "/", "sleep");
    tmux.newWindow("s12x", "/", "sleep");
    expect(runner.liveSessionIds()).toEqual(new Set());
  });
});
