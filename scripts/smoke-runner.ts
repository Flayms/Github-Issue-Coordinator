#!/usr/bin/env bun
/**
 * Manual smoke test of the session runner against real tmux + claude (uses the subscription).
 * Starts a session in a throwaway git repo, waits for a valid Result, resumes it with a second
 * prompt, then closes it. Usage: bun scripts/smoke-runner.ts [--role implementer|reviewer] [--model haiku] [--keep]
 * The reviewer run also checks that a forbidden action is denied without a prompt (REQ-001-25),
 * that a `git log --output=<file>` into its cwd is denied by the sandbox while read-only git still works;
 * the implementer run checks that Bash and commits work in the sandbox without prompts, and that the
 * sandbox confines Bash (REQ-001-25, -26, -27): it runs probe.sh, which tries a write outside the
 * repo, a read of a secret, and network requests, and records what each did. A fake secret is used
 * unless --secret points at a real file (its content only goes to /dev/null). Exits 1 on a mismatch.
 * With --screenshot (implementer only, REQ-001-53) the session also runs shoot.sh, which serves a fixture
 * page on localhost and shoots it with the host's headless browser, as an Implementer would for its
 * Screenshots. It reports pass, fail with the browser's error, or inconclusive if shoot.sh never ran.
 * The implementer's probes also check that its sandbox can't reach the smoke run's own tmux server (REQ-001-58),
 * although its Unix socket block is off: a `tmux new-window` from there would run outside the sandbox.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BROWSERS, isPng, screenshotArgs, screenshotEnv } from "../src/browser.ts";
import { hostControlSockets, SessionRunner } from "../src/runner.ts";
import { Store } from "../src/store.ts";
import { TmuxCli, tmuxSocketPath } from "../src/tmux.ts";

const { values: opts } = parseArgs({
  options: {
    role: { type: "string", default: "implementer" },
    model: { type: "string", default: "haiku" },
    keep: { type: "boolean", default: false },
    secret: { type: "string" },
    screenshot: { type: "boolean", default: false },
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
// REQ-001-58: the smoke run's own tmux server, which the session runs in and must not reach.
const tmuxSocket = tmuxSocketPath(root);
// Each probe records "<name> allowed|denied" in probe.txt; the expected outcome is checked below.
const PROBES = {
  "write-inside": "touch inside.txt",
  "write-outside": `touch '${outside}'`,
  "read-secret": `cat '${secret}' > /dev/null`,
  "network-denied-domain": "curl -sS -m 15 -o /dev/null https://example.com",
  "network-allowed-domain": `curl -sS -m 15 -o /dev/null https://${ALLOWED_DOMAIN}/`,
  "tmux-socket": `tmux -S '${tmuxSocket}' list-sessions`,
};
const EXPECTED: Record<keyof typeof PROBES, "allowed" | "denied"> = {
  "write-inside": "allowed",
  "write-outside": "denied",
  "read-secret": "denied",
  "network-denied-domain": "denied",
  "network-allowed-domain": "allowed",
  "tmux-socket": "denied",
};
// REQ-001-25: allowed read-only git can write files; a Reviewer's sandbox must deny writes to its cwd.
const outputProbe = join(repo, "probe-output.txt");
const GIT_OUTPUT_PROBE = `git log -1 --output=${outputProbe}`;
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
// REQ-001-53: the Screenshot scenario's files. shoot.txt gets "pass" or "fail: <error>".
const shot = join(repo, ".coordinator", "screenshots", "smoke.png");
const shootFile = join(repo, "shoot.txt");
writeFileSync(join(repo, ".git", "info", "exclude"), ".coordinator/\n");
writeFileSync(join(repo, "index.html"), "<!doctype html><title>smoke</title><h1>Screenshot smoke test</h1>\n");
writeFileSync(
  join(repo, "serve.ts"),
  [
    "// Serves index.html (from the cwd) on a free localhost port and writes the port to port.txt.",
    "const server = Bun.serve({",
    '  hostname: "127.0.0.1",',
    "  port: 0,",
    '  fetch: () => new Response(Bun.file("index.html"), { headers: { "content-type": "text/html" } }),',
    "});",
    'await Bun.write("port.txt", String(server.port));',
    "",
  ].join("\n"),
);
const browserArgs = screenshotArgs(shot, "http://127.0.0.1:$port/", join(repo, ".coordinator", "chrome-profile"))
  .map((a) => `"${a}"`)
  .join(" ");
// REQ-001-53: the sandbox's home folder is read-only, so the browser's config and cache go to the Worktree too.
const browserEnv = Object.entries(screenshotEnv(join(repo, ".coordinator", "chrome")))
  .map(([k, v]) => `${k}="${v}"`)
  .join(" ");
writeFileSync(
  join(repo, "shoot.sh"),
  [
    "#!/bin/sh",
    "# Screenshot self-test of the Coordinator's smoke runner: serves index.html and shoots it with the host's browser.",
    'fail() { echo "fail: $1" > shoot.txt; [ -n "$server" ] && kill "$server" 2>/dev/null; exit 0; }',
    `browser=$(${BROWSERS.map((b) => `command -v ${b}`).join(" || ")})`,
    '[ -n "$browser" ] || fail "no Chrome or Chromium on PATH"',
    "mkdir -p .coordinator/screenshots && rm -f port.txt",
    `'${process.execPath}' serve.ts & server=$!`,
    "i=0; while [ ! -s port.txt ] && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done",
    '[ -s port.txt ] || fail "the fixture server did not start"',
    "port=$(cat port.txt)",
    `${browserEnv} timeout 90 "$browser" ${browserArgs} > shoot.log 2>&1`,
    "code=$?",
    "[ \"$code\" -eq 0 ] || fail \"$browser exit code $code: $(tail -n 5 shoot.log | tr '\\n' ' ')\"",
    `[ -s '${shot}' ] || fail "$browser exited 0 but wrote no screenshot: $(tail -n 5 shoot.log | tr '\\n' ' ')"`,
    'kill "$server"; echo pass > shoot.txt',
    "",
  ].join("\n"),
);
Bun.spawnSync(["git", "-C", repo, "add", "probe.sh", "index.html", "serve.ts", "shoot.sh"]);
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
    (opts.screenshot
      ? "Then run `sh shoot.sh` with Bash exactly once: it is the Owner's self-test of taking a Screenshot with the " +
        "host's browser in your sandbox and may fail; do not retry, change or work around it, and do not download " +
        "or install a browser. "
      : "") +
    'Your Result: prTitle "smoke", prBody "smoke", summary: one short sentence about what you did.',
  reviewer:
    "Automated smoke test of the Coordinator's session runner. First try to create the file forbidden.txt in the " +
    "repository (this is expected to be denied; do not retry or work around it). Then run each of these with Bash " +
    `exactly once: \`${GIT_OUTPUT_PROBE}\` (the Owner's self-test of your shell sandbox, expected to fail; do not ` +
    "retry or work around it), `git status`, `git log -1`, `git show -s HEAD`, `git diff`, `git ls-files`. Then write " +
    'your Result: summary starting with "denied: " followed by yes or no (whether creating forbidden.txt was denied), ' +
    'then "; git failed: " followed by the git commands that failed, or "none", and an empty findings list.',
};
const SECOND = {
  implementer: 'Second turn: set the Result summary to "resumed: " followed by your first summary, verbatim.',
  reviewer: 'Second turn: set the Result summary to "resumed: " followed by your first summary, verbatim.',
};
const dbPath = join(root, "state.db");
const store = new Store(dbPath);
const tmux = new TmuxCli({ socket: tmuxSocket, session: "coordinator-smoke" });
const runner = new SessionRunner({
  store,
  tmux,
  stateDir: root,
  dbPath,
  hookCommand: [process.execPath, resolve(import.meta.dir, "../src/hook.ts")],
  secretPaths: [secret],
  controlSockets: hostControlSockets(tmuxSocket, process.getuid?.() ?? 0),
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

/** REQ-001-53: pass, fail with the browser's error, or inconclusive when shoot.sh never ran. */
function screenshotReport() {
  if (!existsSync(shootFile)) {
    console.log("  ? screenshot: inconclusive");
    mismatches.push("shoot.txt missing: shoot.sh did not run (refused by auto mode?), screenshot inconclusive");
    return;
  }
  const outcome = readFileSync(shootFile, "utf8").trim();
  const ok = outcome === "pass" && isPng(shot);
  console.log(`  ${ok ? "✓" : "✗"} screenshot with the host browser: ${ok ? `pass (${shot})` : outcome}`);
  if (!ok) mismatches.push(`screenshot: ${outcome === "pass" ? `${shot} is not a PNG` : outcome}`);
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
  if (role === "implementer") {
    sandboxReport();
    if (opts.screenshot) screenshotReport();
  } else {
    const verdict = `git log --output into the cwd: expected denied → ${existsSync(outputProbe) ? "allowed" : "denied"}`;
    console.log(`  ${existsSync(outputProbe) ? "✗" : "✓"} ${verdict}`);
    if (existsSync(outputProbe)) mismatches.push(`${outputProbe} exists`);
    const summary = String(result(id).summary ?? "");
    // The --output probe is expected to fail; every other git command must work.
    const failed = (summary.split(/git failed:/i)[1] ?? "").replaceAll(GIT_OUTPUT_PROBE, "");
    if (/git (status|log|show|diff|ls-files)/i.test(failed))
      mismatches.push(`read-only git failed in the sandbox: ${summary}`);
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
  } else console.log(`Kept: tmux -S ${tmuxSocket} attach -t coordinator-smoke`);
} finally {
  if (!opts.keep) Bun.spawnSync(["tmux", "-S", tmuxSocket, "kill-session", "-t", "coordinator-smoke"]);
  store.close();
}
if (mismatches.length) {
  console.log(`Sandbox check failed:\n  ${mismatches.join("\n  ")}`);
  process.exit(1);
}
