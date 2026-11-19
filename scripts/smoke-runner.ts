#!/usr/bin/env bun
/**
 * Manual smoke test of the session runner against real tmux and a real Harness CLI (uses its login).
 * Starts a session in a throwaway git repo, waits for a valid Result, resumes it with a second
 * prompt, then closes it. Usage: bun scripts/smoke-runner.ts [--harness claude|codex|copilot]
 * [--role implementer|reviewer] [--model haiku] [--fake-model] [--keep]. `--fake-model` with `--harness codex` or
 * `--harness copilot` runs the real CLI against a local fake model server (scripts/fake-model-server.ts): no login, no
 * cost (docs/harnesses.md). A Harness whose CLI is missing, or that isn't logged in, is skipped.
 * Checks that the session runs with skipped permissions (REQ-005-01): no permission prompt, and the Implementer's
 * commands and commit work. Exits 1 on a mismatch. Prints the Usage quota the status line recorded (REQ-001-67); it is
 * missing on plans without rate limits, so that is no mismatch.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Account } from "../src/accounts.ts";
import { loginStatus } from "../src/harness/checks.ts";
import { harnessByName } from "../src/harness/index.ts";
import { SessionRunner } from "../src/runner.ts";
import { Store } from "../src/store.ts";
import { TmuxCli } from "../src/tmux.ts";
import { startFakeModelServer } from "./fake-model-server.ts";

const { values: opts } = parseArgs({
  options: {
    harness: { type: "string", default: "claude" },
    role: { type: "string", default: "implementer" },
    model: { type: "string" },
    "fake-model": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});
const harness = harnessByName(opts.harness ?? "claude");
const fake = opts["fake-model"] && harness.name !== "claude";
if (opts["fake-model"] && !fake) throw new Error("--fake-model works with --harness codex or copilot only");
const root = mkdtempSync(join(tmpdir(), "coordinator-smoke-"));
// REQ-006-05: skip a Harness that can't run here, rather than fail.
const version = Bun.spawnSync([harness.bin, "--version"], { stdout: "pipe", stderr: "pipe" });
if (version.exitCode !== 0) {
  console.log(`Skipped: \`${harness.bin}\` is not installed.`);
  process.exit(0);
}
let fakeServer: ReturnType<typeof startFakeModelServer> | undefined;
const accounts: Account[] = [{ name: "smoke", harness: harness.name }];
const tmuxSession = "coordinator-smoke";
if (fake && harness.name === "copilot") {
  // A COPILOT_HOME of its own, and the fake server as the only model provider (`copilot help providers-env`), set on
  // the smoke run's own tmux session so its windows get it and no other session does.
  fakeServer = startFakeModelServer();
  const home = join(root, "copilot-home");
  mkdirSync(home, { recursive: true });
  accounts[0] = { ...accounts[0], configDir: home } as Account;
  const tmuxRun = (args: string[]) => Bun.spawnSync(["tmux", ...args], { stdout: "ignore", stderr: "ignore" });
  if (tmuxRun(["has-session", "-t", tmuxSession]).exitCode !== 0)
    tmuxRun(["new-session", "-d", "-s", tmuxSession, "-n", "keepalive", "-x", "200", "-y", "50"]);
  const vars = {
    COPILOT_PROVIDER_BASE_URL: `${fakeServer.url}/v1`,
    COPILOT_PROVIDER_WIRE_API: "responses",
    // No GitHub sign-in, telemetry or update check.
    COPILOT_OFFLINE: "true",
  };
  for (const [k, v] of Object.entries(vars)) tmuxRun(["set-environment", "-t", tmuxSession, k, v]);
} else if (fake) {
  // A CODEX_HOME of its own, whose only model provider is the fake server.
  fakeServer = startFakeModelServer();
  const home = join(root, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.toml"),
    `model_provider = "fake"\n\n[model_providers.fake]\nname = "fake"\nbase_url = "${fakeServer.url}/v1"\nwire_api = "responses"\n`,
  );
  accounts[0] = { ...accounts[0], configDir: home } as Account;
} else {
  const run = (cmd: string[], env?: Record<string, string | undefined>) => {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim() || p.stderr.toString().trim() };
  };
  if (!loginStatus(harness, accounts[0] as Account, run).ok) {
    console.log(`Skipped: \`${harness.bin}\` is not logged in.`);
    process.exit(0);
  }
}
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
    'Bash. Create the file smoke.txt containing "ok", and commit smoke.txt with git (message "smoke"). ' +
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
const tmux = new TmuxCli(tmuxSession);
const runner = new SessionRunner({
  store,
  tmux,
  stateDir: root,
  dbPath,
  hookCommand: [process.execPath, resolve(import.meta.dir, "../src/hook.ts")],
  accounts,
});
const DEFAULT_MODEL = {
  claude: "haiku",
  codex: fake ? "gpt-fake" : "gpt-5.5",
  copilot: fake ? "copilot:gpt-fake" : "copilot:claude-haiku-5.5",
};
const model = { model: opts.model ?? DEFAULT_MODEL[harness.name] };

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
  console.log(
    `  ${harness.bin} session ${first.agentSessionId}, failures ${first.resultFailures}, result:`,
    result(id),
  );
  if (first.harness !== harness.name) mismatches.push(`the session ran on ${first.harness}`);
  // REQ-001-21: three invalid Results in a row means the Stop hook gave up.
  if (first.resultFailures > 0) mismatches.push(`the first turn ended with ${first.resultFailures} invalid Results`);

  const log = Bun.spawnSync(["git", "-C", repo, "log", "--oneline"]).stdout.toString().trim();
  console.log(`  git log: ${JSON.stringify(log)}`);
  const events = (await Bun.file(join(runner.sessionDir(id), "events.jsonl")).text()).split("\n");
  const notes = events.filter((l) => l.includes('"Notification"')).map((l) => JSON.parse(l).payload.notification_type);
  console.log(`  notifications: ${notes.length ? notes.join(", ") : "none"}`);
  // REQ-005-01: a session with skipped permissions never asks.
  if (notes.includes("permission_prompt")) mismatches.push("the session asked for a permission");
  // A fake model runs no commands, so only a real one can commit.
  if (role === "implementer" && !fake) {
    if (!log.includes("smoke")) mismatches.push("no smoke commit in the repo");
  }

  // REQ-001-67: the status line ran after the first response and stored the Account's Usage quota.
  const account = store.session(id)?.account ?? "";
  console.log(`  usage quota of ${account}: ${JSON.stringify(store.usageQuota(account) ?? "none recorded")}`);

  runner.resume(id, SECOND[role], model);
  const second = await waitIdle(id, "resumed turn");
  console.log(
    `  ${harness.bin} session ${second.agentSessionId} (same: ${second.agentSessionId === first.agentSessionId}), result:`,
    result(id),
  );

  if (!opts.keep) {
    runner.close(id);
    console.log(`Closed: state ${store.session(id)?.state}, window live: ${runner.liveSessionIds().has(id)}`);
  } else console.log("Kept: tmux attach -t coordinator-smoke");
} finally {
  if (!opts.keep) Bun.spawnSync(["tmux", "kill-session", "-t", tmuxSession]);
  store.close();
  fakeServer?.stop();
}
if (mismatches.length) {
  console.log(`Smoke check failed:\n  ${mismatches.join("\n  ")}`);
  process.exit(1);
}
