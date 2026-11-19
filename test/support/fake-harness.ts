#!/usr/bin/env bun
/**
 * A fake Harness CLI for tests (spec 006), with the command line and hooks of Codex CLI or Copilot CLI:
 * - Codex: `-c hooks.<Event>=…`, `resume <id>`, payloads shaped like test/fixtures/codex/hooks.json.
 * - Copilot (`--plugin-dir`): hooks from the plugin's hooks/hooks.json, `--resume <id>`, `-i <prompt>`, payloads shaped
 *   like test/fixtures/copilot/hooks.json, and a blocked Stop's reason submitted as the next prompt, as Copilot does.
 * It fires the hooks and writes a Result where the prompt asks for one. It needs no login and no model, so the whole
 * runner path runs in `bun test`. The Result is `fake-result.json` in its working folder (tmux doesn't pass the test's
 * environment on); it writes none on the first try, so the Stop hook blocks once (REQ-001-21).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const hooks = new Map<string, string>();
let resumeId: string | undefined;
let model = "fake-model";
const copilot = args.includes("--plugin-dir");
for (let i = 0; i < args.length; i++) {
  const a = args[i] ?? "";
  if (a === "resume" || a === "--resume") resumeId = args[++i];
  else if (a === "--model") model = args[++i] ?? model;
  else if (a === "--plugin-dir") {
    const file = JSON.parse(readFileSync(join(args[++i] ?? "", "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, { hooks?: { command: string }[]; bash?: string }[]>;
    };
    for (const [ev, [entry]] of Object.entries(file.hooks)) {
      const command = entry?.hooks?.[0]?.command ?? entry?.bash;
      if (command) hooks.set(ev, command);
    }
  } else if (a === "-c") {
    const m = /^hooks\.(\w+)=.*command=("(?:[^"\\]|\\.)*")/.exec(args[++i] ?? "");
    if (m?.[1] && m[2]) hooks.set(m[1], JSON.parse(m[2]));
  }
}
const prompt = args.at(-1) ?? "";
const sessionId = resumeId ?? crypto.randomUUID();
const env = process.env;
const transcript = copilot
  ? join(env.COPILOT_HOME ?? join(env.HOME ?? "/tmp", ".copilot"), "session-state", sessionId, "events.jsonl")
  : join(
      env.CODEX_HOME ?? join(env.HOME ?? "/tmp", ".codex"),
      ...["sessions", "2026", "11", "19", `rollout-2026-11-19T18-04-30-${sessionId}.jsonl`],
    );
mkdirSync(join(transcript, ".."), { recursive: true });
writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`, { flag: "a" });

// Copilot's SessionStart names neither the transcript nor the model.
const base = { session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), model };
const startPayload = copilot ? { session_id: sessionId, cwd: process.cwd() } : base;
const fire = async (event: string, extra: Record<string, unknown> = {}, payload: object = base): Promise<string> => {
  const command = hooks.get(event);
  if (!command) return "";
  const p = Bun.spawn(["sh", "-c", command], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  p.stdin.write(JSON.stringify({ ...payload, hook_event_name: event, ...extra }));
  p.stdin.end();
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
};

await fire("SessionStart", { source: resumeId ? "resume" : copilot ? "new" : "startup" }, startPayload);
await fire("UserPromptSubmit", { prompt });
const resultPath = /write your Result as JSON to (\S+result\.json)/.exec(prompt)?.[1];
const resultFile = join(process.cwd(), "fake-result.json");
const result = existsSync(resultFile) ? readFileSync(resultFile, "utf8") : undefined;
for (let attempt = 0; attempt < 4; attempt++) {
  if (resultPath && result && attempt > 0) writeFileSync(resultPath, result);
  const out = await fire("Stop", { stop_hook_active: attempt > 0, last_assistant_message: "done" });
  if (!out.includes('"block"')) break;
  if (copilot) await fire("UserPromptSubmit", { prompt: (JSON.parse(out) as { reason: string }).reason });
}
// Stays open like the interactive CLI, until the Coordinator kills its window.
await Bun.sleep(600_000);
