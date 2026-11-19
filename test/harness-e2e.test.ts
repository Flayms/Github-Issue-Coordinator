/**
 * Spec 006: a Codex and a Copilot session end to end through real tmux and the real hook script, with the fake Harness
 * CLI in place of `codex` and `copilot` (test/support/fake-harness.ts), so no login is needed. Skipped where tmux is
 * missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessName } from "../src/harness/index.ts";
import { SessionRunner } from "../src/runner.ts";
import { Store } from "../src/store.ts";
import { TmuxCli } from "../src/tmux.ts";

const hasTmux = Bun.spawnSync(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const RESULT = JSON.stringify({ summary: "ok", risk: "low", riskReason: "tiny", findings: [] });

const CASES: { harness: HarnessName; label: string; model: string; transcripts: string | null }[] = [
  { harness: "codex", label: "Codex", model: "gpt-6.2-sol", transcripts: "sessions" },
  // Copilot's SessionStart names no transcript.
  { harness: "copilot", label: "Copilot", model: "copilot:gpt-6.1-sol", transcripts: null },
];

for (const c of CASES)
  describe.skipIf(!hasTmux)(`${c.label} session through tmux with a fake Harness CLI`, () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-e2e-"));
    const tmuxSession = `coordinator-test-${process.pid}-${c.harness}`;
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
        bins: { [c.harness]: resolve(import.meta.dir, "support/fake-harness.ts") },
        accounts: [{ name: "gpt", harness: c.harness, configDir: join(dir, "agent-home") }],
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

    test(`REQ-006-01 / REQ-006-03 / REQ-006-07 / REQ-006-08 a Reviewer turn runs, its Result is validated by the Stop hook, and it resumes on ${c.label}`, async () => {
      const id = runner.start({
        repo: "octo/app",
        role: "reviewer",
        kind: "issue",
        issues: [5],
        cwd: dir,
        prompt: "Review it.",
        model: { model: c.model },
      });
      await waitFor(id, () => store.session(id)?.state === "idle");
      const first = store.session(id);
      // The fake wrote no Result on the first try, so the Stop hook blocked once (REQ-001-21), then passed.
      expect(first).toMatchObject({ harness: c.harness, account: "gpt", needsSync: true, resultFailures: 0 });
      // REQ-006-07: Copilot sends the block reason back as a prompt; that is not the Owner's message (REQ-001-19).
      expect(first?.ownerMessagedAt).toBeNull();
      expect(first?.agentSessionId).toBeTruthy();
      if (c.transcripts) expect(first?.transcriptPath).toStartWith(join(dir, "agent-home", c.transcripts));

      store.patchSession(id, { needsSync: false });
      runner.resume(id, "Again.", { model: c.model });
      await waitFor(id, () => store.session(id)?.state === "idle" && store.session(id)?.needsSync === true);
      expect(store.session(id)?.agentSessionId).toBe(first?.agentSessionId ?? "");
      runner.close(id);
    }, 30_000);
  });
