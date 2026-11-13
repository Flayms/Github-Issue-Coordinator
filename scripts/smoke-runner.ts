#!/usr/bin/env bun
/**
 * Manual smoke test of the session runner against real tmux + claude (uses the subscription).
 * Starts a session in a throwaway git repo, waits for a valid Result, resumes it with a second
 * prompt, then closes it. Usage: bun scripts/smoke-runner.ts [--role implementer|reviewer] [--model haiku] [--keep]
 * The reviewer run also checks that a forbidden action is denied without a prompt (REQ-001-25);
 * the implementer run checks that Bash and commits work in the sandbox without prompts, and that the
 * sandbox confines Bash (REQ-001-25, -26, -27): it runs probe.sh, which tries a write outside the
 * repo, a read of a secret, and network requests, and records what each did. A fake secret is used
 * unless --secret points at a real file (its content only goes to /dev/null). Exits 1 on a mismatch.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    secret: { type: "string" },
  },
});
const root = mkdtempSync(join(tmpdir(), "coordinator-smoke-"));
const repo = join(root, "repo");
const outside = join(root, "outside.txt");
const secret = opts.secret ? resolve(opts.secret) : join(root, "secrets", "app.pem");
if (!opts.secret) {
  mkdirSync(join(root, "secrets"));
  writeFileSync(secret, "not a real key\n");
}
const ALLOWED_DOMAIN = "registry.npmjs.org";
// Each probe records "<name> allowed|denied" in probe.txt; the expected outcome is checked below.
const PROBES = {
  "write-inside": "touch inside.txt",
  "write-outside": `touch '${outside}'`,
  "read-secret": `cat '${secret}' > /dev/null`,
  "network-denied-domain": "curl -sS -m 15 -o /dev/null https://example.com",
  "network-allowed-domain": `curl -sS -m 15 -o /dev/null https://${ALLOWED_DOMAIN}/`,
};
const EXPECTED: Record<keyof typeof PROBES, "allowed" | "denied"> = {
  "write-inside": "allowed",
  "write-outside": "denied",
  "read-secret": "denied",
  "network-denied-domain": "denied",
  "network-allowed-domain": "allowed",
};
Bun.spawnSync(["git", "init", "-q", repo]);
writeFileSync(
  join(repo, "probe.sh"),
  [
    "#!/bin/sh",
    "# Sandbox self-test of the Coordinator's smoke runner: records whether each action worked.",
    ": > probe.txt",
    ...Object.entries(PROBES).map(
      ([name, cmd]) =>
        `if ${cmd} 2>/dev/null; then echo "${name} allowed"; else echo "${name} denied"; fi >> probe.txt`,
    ),
    "",
  ].join("\n"),
);
Bun.spawnSync(["git", "-C", repo, "add", "probe.sh"]);
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
    "Bash. Then run `sh probe.sh` with Bash exactly once: it is the Owner's self-test of your shell sandbox and is " +
    "expected to have some of its actions denied; do not retry, change or work around it. Create the file smoke.txt " +
    'containing "ok", and commit all files with git (message "smoke"). ' +
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
  secretPaths: [secret],
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

/** Compares probe.txt with the expected outcomes and with what can be seen from outside the sandbox. */
function sandboxReport() {
  const probeFile = join(repo, "probe.txt");
  if (!existsSync(probeFile)) {
    mismatches.push("probe.txt missing: probe.sh did not run (refused by auto mode?), sandbox inconclusive");
    return;
  }
  const seen = Object.fromEntries(
    readFileSync(probeFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split(" ") as [string, string]),
  );
  console.log("  sandbox probes (expected → observed):");
  for (const [name, want] of Object.entries(EXPECTED)) {
    const got = seen[name] ?? "missing";
    console.log(`    ${got === want ? "✓" : "✗"} ${name}: ${want} → ${got}`);
    if (got !== want) mismatches.push(`${name}: expected ${want}, observed ${got}`);
  }
  if (existsSync(outside)) mismatches.push(`write-outside: ${outside} exists`);
  const committed = Bun.spawnSync(["git", "-C", repo, "log", "--format=%s"]).stdout.toString();
  if (!committed.includes("smoke")) mismatches.push("no smoke commit in the repo");
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
    sandboxDomains: [ALLOWED_DOMAIN],
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
  if (role === "implementer") sandboxReport();

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
  console.log(`Sandbox check failed:\n  ${mismatches.join("\n  ")}`);
  process.exit(1);
}
