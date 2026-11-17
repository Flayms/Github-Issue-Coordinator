#!/usr/bin/env bun
/**
 * Manual smoke test of the session runner against real tmux + claude (uses the subscription).
 * Starts a session in a throwaway git repo, waits for a valid Result, resumes it with a second
 * prompt, then closes it. Usage: bun scripts/smoke-runner.ts [--role implementer|reviewer] [--model haiku] [--keep]
 * Checks that the session runs with skipped permissions (REQ-005-01): no permission prompt, the Implementer's
 * commands and commit work, and whether `sudo` works without a password. Exits 1 on a mismatch.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SessionRunner } from "../src/runner.ts";
import { Store } from "../src/store.ts";
import { TmuxCli } from "../src/tmux.ts";

const { values: opts } = parseArgs({
  options: {
    role: { type: "string", default: "implementer" },
    model: { type: "string", default: "haiku" },
    keep: { type: "boolean", default: false },
  },
});
const root = mkdtempSync(join(tmpdir(), "coordinator-smoke-"));
const repo = join(root, "repo");
Bun.spawnSync(["git", "init", "-q", repo]);
Bun.spawnSync([
  "git",
  "-C",
  repo,
  "-c",
  "user.name=smoke",
  "-c",
  "user.email=smoke@localhost",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "init",
]);
const role = opts.role === "reviewer" ? "reviewer" : "implementer";
const PROMPTS = {
  implementer:
    "Automated smoke test of the Coordinator's session runner, run by its Owner. Run `ls -la` and `git status` with " +
    "Bash. Then run `sudo -n true && echo yes > sudo.txt || echo no > sudo.txt` exactly once. Create the file " +
    'smoke.txt containing "ok", and commit smoke.txt with git (message "smoke"). ' +
    'Your Result: prTitle "smoke", prBody "smoke", summary: one short sentence about what you did.',
  reviewer:
    "Automated smoke test of the Coordinator's session runner. Run `git status`, `git log -1` and `git ls-files` " +
    "with Bash, then write your Result: a one-sentence summary and an empty findings list.",
};
const SECOND = {
  implementer: 'Second turn: set the Result summary to "resumed: " followed by your first summary, verbatim.',
  reviewer: 'Second turn: set the Result summary to "resumed: " followed by your first summary, verbatim.',
};
const dbPath = join(root, "state.db");
const store = new Store(dbPath);
const tmux = new TmuxCli("coordinator-smoke");
const runner = new SessionRunner({
  store,
  tmux,
  stateDir: root,
  dbPath,
  hookCommand: [process.execPath, resolve(import.meta.dir, "../src/hook.ts")],
});
const model = { model: opts.model ?? "haiku" };

async function waitIdle(id: number, label: string, ms = 240_000) {
  const start = Date.now();
  process.stdout.write(`… ${label}`);
  while (Date.now() - start < ms) {
    runner.answerDialogs();
    const s = store.session(id);
    if (s?.state === "idle" && (s.needsSync || s.usageLimited)) {
      process.stdout.write(` ✓ (${Math.round((Date.now() - start) / 1000)}s)\n`);
      return s;
    }
    if (!runner.liveSessionIds().has(id)) throw new Error(`window closed while waiting for ${label}`);
    process.stdout.write(".");
    await Bun.sleep(2000);
  }
  console.log(`\n${tmux.capture(`s${id}`)}`);
  throw new Error(`timeout waiting for ${label}`);
}

const mismatches: string[] = [];
const result = (id: number) => JSON.parse(readFileSync(join(runner.sessionDir(id), "result.json"), "utf8"));

try {
  const id = runner.start({
    repo: "smoke/test",
    role,
    kind: "issue",
    issues: [1],
    cwd: repo,
    model,
    prompt: PROMPTS[role],
  });
  console.log(`Started session ${id} as "smoke/test#1 ${role}" (state dir ${root}).`);
  const first = await waitIdle(id, "first turn");
  console.log(`  claude session ${first.claudeSessionId}, failures ${first.resultFailures}, result:`, result(id));

  const log = Bun.spawnSync(["git", "-C", repo, "log", "--oneline"]).stdout.toString().trim();
  console.log(`  git log: ${JSON.stringify(log)}`);
  const events = (await Bun.file(join(runner.sessionDir(id), "events.jsonl")).text()).split("\n");
  const notes = events.filter((l) => l.includes('"Notification"')).map((l) => JSON.parse(l).payload.notification_type);
  console.log(`  notifications: ${notes.length ? notes.join(", ") : "none"}`);
  // REQ-005-01: a session with skipped permissions never asks.
  if (notes.includes("permission_prompt")) mismatches.push("the session asked for a permission");
  if (role === "implementer") {
    if (!log.includes("smoke")) mismatches.push("no smoke commit in the repo");
    const sudo = join(repo, "sudo.txt");
    const answer = existsSync(sudo) ? readFileSync(sudo, "utf8").trim() : "not run";
    console.log(`  ${answer === "yes" ? "✓" : "!"} sudo without a password: ${answer}`);
  }

  runner.resume(id, SECOND[role], model);
  const second = await waitIdle(id, "resumed turn");
  console.log(
    `  claude session ${second.claudeSessionId} (same: ${second.claudeSessionId === first.claudeSessionId}), result:`,
    result(id),
  );

  if (!opts.keep) {
    runner.close(id);
    console.log(`Closed: state ${store.session(id)?.state}, window live: ${runner.liveSessionIds().has(id)}`);
  } else console.log("Kept: tmux attach -t coordinator-smoke");
} finally {
  if (!opts.keep) Bun.spawnSync(["tmux", "kill-session", "-t", "coordinator-smoke"]);
  store.close();
}
if (mismatches.length) {
  console.log(`Smoke check failed:\n  ${mismatches.join("\n  ")}`);
  process.exit(1);
}
