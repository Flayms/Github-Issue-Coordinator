#!/usr/bin/env bun
/**
 * T0 spike (docs/specs/001-issue-coordinator/plan.md).
 *
 * Verifies on the server, without any manual `claude` commands, that interactive Claude Code
 * sessions can be started and resumed unattended in a detached tmux session, are registered
 * with Remote Control, report their lifecycle via hooks, and can be steered by a blocking Stop
 * hook. Writes a Markdown report to spikes/t0/reports/.
 *
 * Usage: bun spikes/t0/t0.ts [--model <m>] [--effort <e>] [--timeout <sec>] [--no-phone] [--pretrust] [--keep]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    model: { type: "string" },
    effort: { type: "string" },
    timeout: { type: "string", default: "300" },
    "no-phone": { type: "boolean", default: false },
    pretrust: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});

const TMUX_SESSION = "coordinator-t0";
const SESSION_NAME = "t0 coordinator test";
const DIALOG = /trust|do you want|enable remote control|press enter|\(y\/n\)|❯ 1\./i;
const timeoutMs = Number(opts.timeout) * 1000;
const phone = !opts["no-phone"];

const hookScript = resolve(import.meta.dir, "hook.ts");
const root = mkdtempSync(join(tmpdir(), "coordinator-t0-"));
const workDir = join(root, "repo");
const stateDir = join(root, "state");
mkdirSync(workDir);
mkdirSync(stateDir);
const eventsFile = join(stateDir, "events.jsonl");
const resultPath = join(stateDir, "result.json");
const settingsPath = join(root, "settings.json");

type Status = "pass" | "fail" | "skip" | "info";
type Ev = { t: string; event: string; blocked?: boolean; problem?: string | null; payload: Record<string, any> };

const checks: { name: string; status: Status; detail: string }[] = [];
const panes: { label: string; text: string }[] = [];
let trustAnswered = false;

function check(name: string, status: Status, detail = "") {
  checks.push({ name, status, detail });
  console.log(`[${status.toUpperCase()}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(cmd: string[], cwd?: string) {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const randomWord = () => crypto.randomUUID().slice(0, 8);

const readEvents = (): Ev[] =>
  existsSync(eventsFile)
    ? readFileSync(eventsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const capture = () => run(["tmux", "capture-pane", "-p", "-t", TMUX_SESSION]).out;

function ask(question: string): string | null {
  if (!phone) return null;
  return (prompt(`\n${question}`) ?? "").trim();
}

function setExpected(word: string) {
  writeFileSync(join(stateDir, "expected.json"), JSON.stringify({ ok: true, word }));
  rmSync(join(stateDir, "stop-blocks"), { force: true });
}

function claudeArgs(name: string, promptText: string, resumeId?: string): string[] {
  // Prompt must follow a single-value flag: --add-dir may be variadic, --remote-control has an optional value.
  const args: string[] = [];
  if (resumeId) args.push("--resume", resumeId);
  args.push("--add-dir", stateDir, "--settings", settingsPath);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort && hasEffort) args.push("--effort", opts.effort);
  args.push("--remote-control", name, "--permission-mode", "acceptEdits", promptText);
  return args;
}

function launch(label: string, args: string[]) {
  const script = join(root, `${label}.sh`);
  writeFileSync(
    script,
    `#!/usr/bin/env bash\ncd ${q(workDir)}\nclaude ${args.map(q).join(" ")}\necho "[claude exited with code $?]"\nsleep 3600\n`,
  );
  run(["tmux", "kill-session", "-t", TMUX_SESSION]);
  const r = run(["tmux", "new-session", "-d", "-s", TMUX_SESSION, "-x", "200", "-y", "50", "bash", script]);
  if (!r.ok) throw new Error(`tmux new-session failed: ${r.err}`);
}

async function waitFor<T>(label: string, pick: (evs: Ev[]) => T | undefined, ms = timeoutMs): Promise<T | undefined> {
  const start = Date.now();
  let pane = "";
  let dialogReported = false;
  process.stdout.write(`… waiting for ${label}`);
  while (Date.now() - start < ms) {
    const hit = pick(readEvents());
    if (hit !== undefined) {
      process.stdout.write(" ✓\n");
      return hit;
    }
    pane = capture();
    if (/\[claude exited with code/.test(pane)) {
      process.stdout.write(" ✗ (claude exited)\n");
      panes.push({ label: `claude exited while waiting for ${label}`, text: pane });
      return undefined;
    }
    if (!trustAnswered && /Yes, I trust this folder/.test(pane)) {
      // Fallback the Coordinator could also use: answer the trust dialog via tmux keys.
      trustAnswered = true;
      panes.push({ label: "folder trust dialog", text: pane });
      run(["tmux", "send-keys", "-t", TMUX_SESSION, "Down"]);
      await Bun.sleep(300);
      run(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
      check(
        "folder trust dialog avoided",
        "fail",
        opts.pretrust ? "appeared despite --pretrust; answered via tmux send-keys" : "appeared (run with --pretrust); answered via tmux send-keys",
      );
    }
    if (!dialogReported && Date.now() - start > 15_000 && DIALOG.test(pane)) {
      dialogReported = true;
      console.log(`\n⚠ Possibly blocked by a dialog while waiting for ${label}. Pane:\n${pane}\n`);
      panes.push({ label: `possible dialog while waiting for ${label}`, text: pane });
    }
    process.stdout.write(".");
    await Bun.sleep(1000);
  }
  process.stdout.write(" ✗ (timeout)\n");
  panes.push({ label: `timeout waiting for ${label}`, text: pane });
  return undefined;
}

function modelsFromTranscript(path: string | undefined): string[] {
  if (!path || !existsSync(path)) return [];
  const models = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const m = JSON.parse(line)?.message?.model;
      if (typeof m === "string") models.add(m);
    } catch {}
  }
  return [...models];
}

function finish(): never {
  if (!opts.keep) run(["tmux", "kill-session", "-t", TMUX_SESSION]);
  const counts = readEvents().reduce<Record<string, number>>((acc, e) => {
    acc[e.event] = (acc[e.event] ?? 0) + 1;
    return acc;
  }, {});
  const report = [
    `# T0 spike report — ${new Date().toISOString()}`,
    "",
    `- Options: \`${JSON.stringify(opts)}\``,
    `- Temp dir (events, transcripts of the run): \`${root}\``,
    "",
    "| Check | Status | Detail |",
    "| ----- | ------ | ------ |",
    ...checks.map((c) => `| ${c.name} | ${c.status} | ${c.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
    `Hook events: \`${JSON.stringify(counts)}\``,
    "",
    ...panes.flatMap((p) => [`## Pane: ${p.label}`, "", "```text", p.text, "```", ""]),
  ].join("\n");
  const dir = join(import.meta.dir, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, report);
  console.log(`\nReport written to ${file}${opts.keep ? `\ntmux session kept: tmux attach -t ${TMUX_SESSION}` : ""}`);
  process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
}

// ── Preflight ────────────────────────────────────────────────────────────────
for (const [bin, ...args] of [["claude", "--version"], ["tmux", "-V"], ["git", "--version"]] as const) {
  const r = run([bin, ...args]);
  check(`${bin} installed`, r.ok ? "pass" : "fail", r.ok ? r.out : r.err);
}
if (checks.some((c) => c.status === "fail")) finish();

const help = run(["claude", "--help"]).out;
const required = ["--remote-control", "--resume", "--settings", "--add-dir", "--model", "--permission-mode"];
const missing = required.filter((f) => !help.includes(f));
check("claude --help lists required flags", missing.length ? "fail" : "pass", missing.length ? `missing: ${missing.join(", ")}` : required.join(", "));
const hasEffort = help.includes("--effort");
check("(d) --effort flag available", hasEffort ? "pass" : "fail", hasEffort ? "" : "not in claude --help");
const auth = run(["claude", "auth", "status"]);
check("claude auth status", "info", (auth.out || auth.err).slice(0, 300));

run(["git", "init", "-q"], workDir);
writeFileSync(join(workDir, "README.md"), "# T0 spike repo\n");
run(["git", "-c", "user.name=t0", "-c", "user.email=t0@localhost", "commit", "-qam", "init", "--allow-empty"], workDir);
run(["git", "add", "-A"], workDir);
run(["git", "-c", "user.name=t0", "-c", "user.email=t0@localhost", "commit", "-qm", "readme"], workDir);

const hookCmd = (ev: string) => `${q(process.execPath)} ${q(hookScript)} ${ev} ${q(stateDir)}`;
const hookEvents = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"];
writeFileSync(
  settingsPath,
  JSON.stringify(
    { hooks: Object.fromEntries(hookEvents.map((ev) => [ev, [{ hooks: [{ type: "command", command: hookCmd(ev) }] }]])) },
    null,
    2,
  ),
);

if (opts.pretrust) {
  const cfgPath = join(homedir(), ".claude.json");
  if (existsSync(cfgPath)) copyFileSync(cfgPath, `${cfgPath}.t0-backup`);
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  cfg.projects ??= {};
  cfg.projects[workDir] = { ...(cfg.projects[workDir] ?? {}), hasTrustDialogAccepted: true };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  check("pre-trusted work dir in ~/.claude.json", "info", `backup at ${cfgPath}.t0-backup`);
}

process.on("SIGINT", () => {
  console.log("\nInterrupted.");
  panes.push({ label: "at interrupt", text: capture() });
  check("run completed", "fail", "interrupted with Ctrl+C");
  finish();
});

// ── Phase A: fresh session, blocking Stop hook, phone visibility ─────────────
const word1 = randomWord();
setExpected(word1);
launch("a", claudeArgs(SESSION_NAME, "This is an automated connectivity test. Reply with one short sentence, then end your turn."));

const sessionId = await waitFor("SessionStart", (evs) => evs.find((e) => e.event === "SessionStart")?.payload?.session_id as string | undefined);
if (!trustAnswered) check("folder trust dialog avoided", "pass", opts.pretrust ? "via --pretrust" : "no dialog shown");
check("(a) session starts unattended in detached tmux", sessionId ? "pass" : "fail", sessionId ? `session_id ${sessionId}` : "see pane capture");
if (!sessionId) finish();

const validA = await waitFor("valid Result (via blocked Stop)", (evs) => evs.find((e) => e.event === "Stop" && e.blocked === false));
const blocksA = readEvents().filter((e) => e.event === "Stop" && e.blocked).length;
check(
  "(c) Stop hook blocks with reason, session continues and fixes Result",
  blocksA >= 1 && validA && !validA.problem ? "pass" : "fail",
  `${blocksA} blocked stop(s), then ${validA ? (validA.problem ? `gave up: ${validA.problem}` : "valid Result") : "no Stop"}`,
);
panes.push({ label: "after phase A", text: capture() });

const seenA = ask(`Open the Claude app. Is a session named "${SESSION_NAME}" listed, showing this conversation? [y/n]`);
check("(a) session visible in Claude app via Remote Control", seenA === null ? "skip" : /^y/i.test(seenA) ? "pass" : "fail", seenA ?? "--no-phone");

if (phone && /^y/i.test(seenA ?? "")) {
  const go = ask(`In that session in the app, send: "reply with PONG". Press Enter once sent, or type "skip".`);
  if (go !== "skip") {
    const before = readEvents().length;
    const ups = await waitFor("UserPromptSubmit from phone", (evs) => evs.slice(before).find((e) => e.event === "UserPromptSubmit"), 120_000);
    const stop = ups && (await waitFor("Stop after phone message", (evs) => evs.slice(before).find((e) => e.event === "Stop"), 120_000));
    check(
      "Owner message from phone fires UserPromptSubmit and Stop hooks",
      ups && stop ? "pass" : "fail",
      ups ? `prompt: ${JSON.stringify(ups.payload?.prompt ?? "").slice(0, 80)}` : "no UserPromptSubmit",
    );
  }
}

// Close the session (as the Coordinator would for an idle session).
const beforeClose = readEvents().length;
run(["tmux", "kill-session", "-t", TMUX_SESSION]);
const ended = await waitFor("SessionEnd after closing", (evs) => evs.slice(beforeClose).find((e) => e.event === "SessionEnd"), 10_000);
check("closing the tmux session fires SessionEnd", ended ? "pass" : "info", ended ? `reason: ${ended.payload?.reason}` : "no SessionEnd within 10s (ok if transcript is intact)");

// ── Phase B: resume with a new prompt ────────────────────────────────────────
const word2 = randomWord();
setExpected(word2);
const beforeB = readEvents().length;
launch(
  "b",
  claudeArgs(
    `${SESSION_NAME} (resumed)`,
    `Update the file ${resultPath} so it contains exactly {"ok":true,"word":"${word2}","recall":"<the one sentence you replied with in your very first turn>"}, then end your turn.`,
    sessionId,
  ),
);
const startB = await waitFor("SessionStart (resume)", (evs) => evs.slice(beforeB).find((e) => e.event === "SessionStart"));
const validB = await waitFor("valid Result after resume", (evs) => evs.slice(beforeB).find((e) => e.event === "Stop" && e.blocked === false && !e.problem));
const resumedResult = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
check(
  "(b) resume with --resume <id> and a new prompt",
  validB ? "pass" : "fail",
  startB
    ? `source=${startB.payload?.source}, session_id ${startB.payload?.session_id === sessionId ? "unchanged" : `changed → ${startB.payload?.session_id}`}`
    : "no SessionStart",
);
check("(b) resumed session remembers earlier turns", "info", `recall: ${JSON.stringify(resumedResult.recall ?? null)}`);
panes.push({ label: "after phase B", text: capture() });

const seenB = ask(`Is the resumed session ("${SESSION_NAME} (resumed)") visible and usable in the Claude app? [y/n]`);
check("(b) resumed session visible in Claude app", seenB === null ? "skip" : /^y/i.test(seenB) ? "pass" : "fail", seenB ?? "--no-phone");

// ── Phase D/E: model, usage limit ────────────────────────────────────────────
const transcript = [...readEvents()].reverse().find((e) => e.payload?.transcript_path)?.payload.transcript_path as string | undefined;
const models = modelsFromTranscript(transcript);
check(
  "(d) model used (from transcript)",
  opts.model ? (models.length && models.every((m) => m.includes(opts.model!)) ? "pass" : "fail") : "info",
  `${models.join(", ") || "none found"}${opts.model ? ` (requested ${opts.model})` : ""}`,
);
check("(e) usage-limit signal", "skip", "cannot be triggered on demand; Notification/Stop payloads are logged so the shape can be captured when it happens");

finish();
