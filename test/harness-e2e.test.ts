/**
 * Spec 006: Codex, Antigravity and Copilot sessions end to end through real tmux and the real hook script, with the fake
 * Harness CLI in place of `codex`, `agy` and `copilot` (test/support/fake-harness.ts), so no login is needed. Skipped
 * where tmux is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionRunner } from "../src/runner.ts";
import { Store } from "../src/store.ts";
import { TmuxCli } from "../src/tmux.ts";

const hasTmux = Bun.spawnSync(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const RESULT = JSON.stringify({ summary: "ok", risk: "low", riskReason: "tiny", findings: [] });

describe.skipIf(!hasTmux)("Harness sessions through tmux with a fake Harness CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-e2e-"));
  const tmuxSession = `coordinator-test-${process.pid}`;
  const tmux = new TmuxCli(tmuxSession);
  let store: Store;
  let runner: SessionRunner;
  beforeAll(() => {
    writeFileSync(join(dir, "fake-result.json"), RESULT);
    store = new Store(join(dir, "state.db"));
    runner = new SessionRunner({
      store,
      tmux,
      stateDir: dir,
      dbPath: join(dir, "state.db"),
      hookCommand: [process.execPath, resolve(import.meta.dir, "../src/hook.ts")],
      bins: {
        codex: resolve(import.meta.dir, "support/fake-harness.ts"),
        antigravity: resolve(import.meta.dir, "support/fake-harness.ts"),
        copilot: resolve(import.meta.dir, "support/fake-harness.ts"),
      },
      accounts: [
        { name: "gpt", harness: "codex", configDir: join(dir, "codex-home") },
        { name: "gemini", harness: "antigravity" },
        { name: "copilot", harness: "copilot", configDir: join(dir, "copilot-home") },
      ],
      home: dir,
    });
  });
  afterAll(() => {
    Bun.spawnSync(["tmux", "kill-session", "-t", tmuxSession]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const waitFor = async (id: number, done: () => boolean) => {
    for (let i = 0; i < 150 && !done(); i++) await Bun.sleep(100);
    if (!done()) throw new Error(`session ${id}: ${runner.screen(id)}\n${JSON.stringify(store.session(id))}`);
  };

  test("REQ-006-01 / REQ-006-03 a Reviewer turn runs, its Result is validated by the Stop hook, and it resumes on Codex", async () => {
    const id = runner.start({
      repo: "octo/app",
      role: "reviewer",
      kind: "issue",
      issues: [5],
      cwd: dir,
      prompt: "Review it.",
      model: { model: "gpt-6.2-sol" },
    });
    await waitFor(id, () => store.session(id)?.state === "idle");
    const first = store.session(id);
    // The fake wrote no Result on the first try, so the Stop hook blocked once (REQ-001-21), then passed.
    expect(first).toMatchObject({ harness: "codex", account: "gpt", needsSync: true, resultFailures: 0 });
    expect(first?.agentSessionId).toBeTruthy();
    expect(first?.transcriptPath).toStartWith(join(dir, "codex-home", "sessions"));

    store.patchSession(id, { needsSync: false });
    runner.resume(id, "Again.", { model: "gpt-6.2-sol" });
    await waitFor(id, () => store.session(id)?.state === "idle" && store.session(id)?.needsSync === true);
    expect(store.session(id)?.agentSessionId).toBe(first?.agentSessionId ?? "");
    runner.close(id);
  }, 30_000);

  test("REQ-006-07 an Antigravity Reviewer turn: the Stop hook continues it until the Result is valid; it resumes by conversation id", async () => {
    const id = runner.start({
      repo: "octo/app",
      role: "reviewer",
      kind: "issue",
      issues: [6],
      cwd: dir,
      prompt: "Review it.",
      model: { model: "gemini-4-neon", effort: "high" },
    });
    await waitFor(id, () => store.session(id)?.state === "idle");
    const first = store.session(id);
    expect(first).toMatchObject({ harness: "antigravity", account: "gemini", needsSync: true, resultFailures: 0 });
    expect(first?.agentSessionId).toBeTruthy();
    expect(first?.modelId).toBe("gemini-4-neon");
    // The continued model call was no new prompt of the Owner's (REQ-001-19).
    expect(first?.ownerMessagedAt).toBeNull();

    store.patchSession(id, { needsSync: false });
    runner.resume(id, "Again.", { model: "gemini-4-neon" });
    await waitFor(id, () => store.session(id)?.state === "idle" && store.session(id)?.needsSync === true);
    expect(store.session(id)?.agentSessionId).toBe(first?.agentSessionId ?? "");
    runner.close(id);
  }, 30_000);

  test("REQ-006-10 / REQ-006-11 a Copilot Reviewer turn: the block reason it sends back is not the Owner's; it resumes by session id", async () => {
    const id = runner.start({
      repo: "octo/app",
      role: "reviewer",
      kind: "issue",
      issues: [7],
      cwd: dir,
      prompt: "Review it.",
      model: { model: "copilot:gpt-6.1-sol" },
    });
    await waitFor(id, () => store.session(id)?.state === "idle");
    const first = store.session(id);
    // The fake wrote no Result on the first try, so the Stop hook blocked once (REQ-001-21), then passed.
    expect(first).toMatchObject({ harness: "copilot", account: "copilot", needsSync: true, resultFailures: 0 });
    expect(first?.agentSessionId).toBeTruthy();
    // Copilot sends the block reason back as a prompt; that is not the Owner's message (REQ-001-19).
    expect(first?.ownerMessagedAt).toBeNull();

    store.patchSession(id, { needsSync: false });
    runner.resume(id, "Again.", { model: "copilot:gpt-6.1-sol" });
    await waitFor(id, () => store.session(id)?.state === "idle" && store.session(id)?.needsSync === true);
    expect(store.session(id)?.agentSessionId).toBe(first?.agentSessionId ?? "");
    runner.close(id);
  }, 30_000);
});
