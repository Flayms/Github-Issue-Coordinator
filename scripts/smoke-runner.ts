#!/usr/bin/env bun
/**
 * Manual smoke test of the session runner against real tmux + claude (uses the subscription).
 * Starts a session in a throwaway git repo, waits for a valid Result, resumes it with a second
 * prompt, then closes it. Usage: bun scripts/smoke-runner.ts [--role implementer|reviewer] [--model haiku] [--keep]
 * The reviewer run also checks that a forbidden action is denied without a prompt (REQ-001-25);
 * the implementer run checks that Bash and commits work in the sandbox without prompts.
 */
import { mkdtempSync, readFileSync } from "node:fs";
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
    "Automated smoke test of the Coordinator's session runner. Run `ls -la` and `git status` with Bash, create the file " +
    'smoke.txt containing "ok", and commit it with git (message "smoke"). ' +
    'Your Result: prTitle "smoke", prBody "smoke", summary: one short sentence about what you did.',
  reviewer:
    "Automated smoke test of the Coordinator's session runner. First try to create the file forbidden.txt in the " +
    "repository (this is expected to be denied; do not retry or work around it). Then write your Result: summary " +
    'starting with "denied: " followed by yes or no (whether creating forbidden.txt was denied), and an empty findings list.',
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
    const blocked = runner.answerDialogs().find((b) => b.sessionId === id);
    if (blocked) throw new Error(`session ${id} is ${blocked.problem}`);
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

  const files = Bun.spawnSync(["git", "-C", repo, "ls-files", "--others", "--cached"]).stdout.toString().trim();
  const log = Bun.spawnSync(["git", "-C", repo, "log", "--oneline"]).stdout.toString().trim();
  console.log(`  repo files: ${JSON.stringify(files)}; git log: ${JSON.stringify(log)}`);
  const events = (await Bun.file(join(runner.sessionDir(id), "events.jsonl")).text()).split("\n");
  const notes = events.filter((l) => l.includes('"Notification"')).map((l) => JSON.parse(l).payload.notification_type);
  console.log(`  notifications: ${notes.length ? notes.join(", ") : "none"}`);

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
