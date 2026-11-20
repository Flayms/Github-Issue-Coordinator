#!/usr/bin/env bun
/**
 * A fake Harness CLI for tests (spec 006): takes the command line of Codex CLI (`-c hooks.<Event>=…`, `resume <id>`, the
 * prompt last), Antigravity CLI (`--add-dir <folder>` with `.agents/hooks.json`, `--conversation <id>`, `-i <prompt>`),
 * Copilot CLI (`--plugin-dir <folder>` with `hooks/hooks.json`, `--resume <id>`, `-i <prompt>`) or OpenCode (`--mini`,
 * `--session <id>`, `--prompt <prompt>`, the plugin in `$OPENCODE_CONFIG_DIR/plugins/`), fires the hooks as that CLI
 * does with payloads shaped like test/fixtures/<harness>/hooks.json (Copilot also sends a blocked Stop's reason back as
 * the next prompt; for OpenCode the real generated plugin runs on OpenCode-shaped events and does that), and writes a
 * Result where the prompt asks for one. It needs no login and no model, so the
 * whole runner path runs in `bun test`. The Result is `fake-result.json` in its working folder (tmux doesn't pass the
 * test's environment on); it writes none on the first try, so the Stop hook blocks once (REQ-001-21).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const hooks = new Map<string, string>();
let resumeId: string | undefined;
let model = "fake-model";
const copilot = args.includes("--plugin-dir");
let agy = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i] ?? "";
  if (a === "resume" || a === "--conversation" || a === "--resume" || a === "--session") resumeId = args[++i];
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
  } else if (a === "--add-dir") {
    // Antigravity: `{ "<name>": { "<Event>": [{ "type": "command", "command": "…" }] } }`.
    agy = true;
    const file = join(args[++i] ?? "", ".agents", "hooks.json");
    if (!existsSync(file)) continue;
    const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, { command: string }[]>>;
    for (const events of Object.values(config))
      for (const [event, handlers] of Object.entries(events)) if (handlers[0]) hooks.set(event, handlers[0].command);
  }
}
const prompt = args.at(-1) ?? "";
const env = process.env;
const resultPath = /write your Result as JSON to (\S+result\.json)/.exec(prompt)?.[1];
const resultFile = join(process.cwd(), "fake-result.json");
const result = existsSync(resultFile) ? readFileSync(resultFile, "utf8") : undefined;

if (args.includes("--mini")) await openCode(resumeId ?? `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`);

/** OpenCode: the plugin gets `session.created` for a new session, then per prompt `chat.message`, busy and idle. */
async function openCode(sessionID: string): Promise<void> {
  const file = join(env.OPENCODE_CONFIG_DIR ?? "", "plugins", "coordinator.js");
  const pending = [prompt];
  let wake = () => {};
  type Plugin = {
    event(i: { event: { type: string; properties: object } }): Promise<void>;
    "chat.message"(i: object, o: { parts: object[] }): Promise<void>;
  };
  const { CoordinatorSession } = (await import(file)) as { CoordinatorSession(i: object): Promise<Plugin> };
  const plugin = await CoordinatorSession({
    client: {
      session: {
        promptAsync: async (o: { body: { parts: { text: string }[] } }) => {
          pending.push(o.body.parts.map((p) => p.text).join(""));
          wake();
        },
        abort: async () => ({ data: true }),
      },
    },
  });
  const event = (type: string, properties: object) => plugin.event({ event: { type, properties } });
  const [providerID, modelID] = model.split("/");
  if (!resumeId) await event("session.created", { sessionID, info: { id: sessionID } });
  // Stays open like the interactive CLI, until the Coordinator kills its window.
  setInterval(() => {}, 60_000);
  for (let turn = 0; ; turn++) {
    while (!pending.length) await new Promise<void>((r) => (wake = r));
    const text = pending.shift() ?? "";
    await plugin["chat.message"](
      { sessionID, agent: "build", model: { providerID, modelID } },
      {
        parts: [{ type: "text", text }],
      },
    );
    await event("session.status", { sessionID, status: { type: "busy" } });
    if (resultPath && result && turn > 0) writeFileSync(resultPath, result);
    await event("session.idle", { sessionID });
  }
}

const sessionId = resumeId ?? crypto.randomUUID();
let transcript: string;
if (agy) {
  // Not written: it would land in the real home folder (tmux passes no test environment on).
  transcript = join(
    "/nonexistent/.gemini/antigravity-cli/brain",
    sessionId,
    ".system_generated/logs/transcript_full.jsonl",
  );
} else {
  transcript = copilot
    ? join(env.COPILOT_HOME ?? join(env.HOME ?? "/tmp", ".copilot"), "session-state", sessionId, "events.jsonl")
    : join(
        env.CODEX_HOME ?? join(env.HOME ?? "/tmp", ".codex"),
        ...["sessions", "2026", "11", "19", `rollout-2026-11-19T18-04-30-${sessionId}.jsonl`],
      );
  mkdirSync(join(transcript, ".."), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`, { flag: "a" });
}

const base = agy
  ? { conversationId: sessionId, transcriptPath: transcript, modelName: model, lastUserInput: prompt }
  : { session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), model };
// Copilot's SessionStart names neither the transcript nor the model.
const startPayload = copilot ? { session_id: sessionId, cwd: process.cwd() } : base;
const fire = async (event: string, extra: Record<string, unknown> = {}, payload: object = base): Promise<string> => {
  const command = hooks.get(event);
  if (!command) return "";
  const p = Bun.spawn(["sh", "-c", command], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  p.stdin.write(JSON.stringify({ ...payload, [agy ? "hookEventName" : "hook_event_name"]: event, ...extra }));
  p.stdin.end();
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
};

// Antigravity fires SessionStart only for a new conversation, and PreInvocation before each model call.
if (!agy || !resumeId)
  await fire("SessionStart", agy ? {} : { source: resumeId ? "resume" : copilot ? "new" : "startup" }, startPayload);
if (!agy) await fire("UserPromptSubmit", { prompt });
for (let attempt = 0; attempt < 4; attempt++) {
  if (agy) await fire("PreInvocation", { invocationNum: attempt, initialNumSteps: 1 + 2 * attempt });
  if (resultPath && result && attempt > 0) writeFileSync(resultPath, result);
  const out = await fire(
    "Stop",
    agy
      ? { executionNum: attempt, terminationReason: "NO_TOOL_CALL", error: "", fullyIdle: true }
      : { stop_hook_active: attempt > 0, last_assistant_message: "done" },
  );
  // Codex and Copilot stop unless told "block"; Antigravity goes on only when told "continue".
  if (!out.includes(agy ? '"continue"' : '"block"')) break;
  if (copilot) await fire("UserPromptSubmit", { prompt: (JSON.parse(out) as { reason: string }).reason });
}
// Stays open like the interactive CLI, until the Coordinator kills its window.
await Bun.sleep(600_000);
