import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TAIL_BYTES, TranscriptReader, tailSteps } from "../src/transcript.ts";

const CWD = "/work/tree";
const URL = "https://claude.ai/code/session_01AbcDEF";

const assistant = (block: Record<string, unknown>, at = "2026-11-19T10:00:00.000Z", extra = {}) =>
  JSON.stringify({ type: "assistant", timestamp: at, cwd: CWD, message: { content: [block] }, ...extra });
const user = (content: unknown, at = "2026-11-19T10:00:01.000Z") =>
  JSON.stringify({ type: "user", timestamp: at, message: { content } });
const bridge = (url: string) =>
  JSON.stringify({
    type: "system",
    subtype: "bridge_status",
    content: `/remote-control is active · Continue here, on your phone, or at ${url}`,
    url,
    timestamp: "2026-11-19T09:59:00.000Z",
  });
const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: "t", name, input });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transcript-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (lines: string[], name = "t.jsonl") => {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
};

describe("transcript", () => {
  test("REQ-003-42 the latest step is thinking, with its text if the transcript has it", () => {
    expect(tailSteps([assistant({ type: "thinking", thinking: "", signature: "x" })]).step).toEqual({
      kind: "thinking",
      text: "",
      at: "2026-11-19T10:00:00.000Z",
    });
    expect(tailSteps([assistant({ type: "thinking", thinking: "Which  test\nfails?" })]).step?.text).toBe(
      "Which test fails?",
    );
  });

  test("REQ-003-42 a tool call shows the tool and a short argument: command, file path or pattern", () => {
    const step = (block: Record<string, unknown>) => tailSteps([assistant(block)]).step;
    expect(step(tool("Bash", { command: "bun test\n  --watch", description: "Run" }))).toMatchObject({
      kind: "tool",
      text: "Bash · bun test --watch",
    });
    expect(step(tool("Read", { file_path: `${CWD}/src/hook.ts` }))?.text).toBe("Read · src/hook.ts");
    expect(step(tool("Edit", { file_path: "/etc/hosts", old_string: "a", new_string: "b" }))?.text).toBe(
      "Edit · /etc/hosts",
    );
    expect(step(tool("Grep", { pattern: "REQ-003-4\\d" }))?.text).toBe("Grep · REQ-003-4\\d");
    expect(step(tool("TodoWrite", { todos: [] }))?.text).toBe("TodoWrite");
  });

  test("REQ-003-42 a running tool is still the latest step; the last text is kept for an ended turn", () => {
    const steps = tailSteps([
      assistant({ type: "text", text: "Now the tests." }, "2026-11-19T10:00:00.000Z"),
      assistant(tool("Bash", { command: "bun test" }), "2026-11-19T10:00:02.000Z"),
      user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
    ]);
    expect(steps.step).toMatchObject({ kind: "tool", text: "Bash · bun test", at: "2026-11-19T10:00:02.000Z" });
    expect(steps.lastText).toEqual({ kind: "says", text: "Now the tests.", at: "2026-11-19T10:00:00.000Z" });
  });

  test("REQ-003-42 skips garbage lines, API error replies, sidechains and unknown blocks", () => {
    const steps = tailSteps([
      assistant({ type: "text", text: "Done." }),
      "not json {",
      "",
      JSON.stringify({ type: "assistant", message: "no content" }),
      assistant({ type: "text", text: "API Error: limit" }, undefined, { isApiErrorMessage: true }),
      assistant({ type: "text", text: "subagent" }, undefined, { isSidechain: true }),
      assistant({ type: "server_tool_use_v9", foo: 1 }),
      JSON.stringify({ type: "system", subtype: "turn_duration" }),
    ]);
    expect(steps.step).toMatchObject({ kind: "says", text: "Done." });
    expect(tailSteps(["{", "[]", "null", "42"])).toEqual({});
  });

  test("REQ-003-42 a long text is cut, so the page never carries a whole message", () => {
    const text = tailSteps([assistant({ type: "text", text: "x".repeat(5000) })]).step?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith("…")).toBe(true);
  });

  test("REQ-003-42 reads only the tail, dropping its cut-off first line", () => {
    const head = assistant({ type: "text", text: "old" });
    const filler = Array.from({ length: 40 }, () => assistant({ type: "text", text: "y".repeat(4000) }));
    const path = file([head, ...filler, assistant(tool("Bash", { command: "bun run lint" }))]);
    const t = new TranscriptReader().read(path);
    expect(t?.step?.text).toBe("Bash · bun run lint");
    expect(TAIL_BYTES).toBe(64 * 1024);
  });

  test("REQ-003-42 a missing, empty or non-transcript file gives nothing", () => {
    const reader = new TranscriptReader();
    expect(reader.read(join(dir, "missing.jsonl"))).toBeUndefined();
    expect(reader.read(file([], "empty.jsonl"))).toEqual({});
    expect(reader.read(file([assistant({ type: "text", text: "hi" })], "notes.txt"))).toBeUndefined();
  });

  test("REQ-003-43 finds the Remote Control URL, also far before the tail", () => {
    const filler = Array.from({ length: 40 }, () => assistant({ type: "text", text: "y".repeat(4000) }));
    const path = file([bridge(URL), ...filler, assistant({ type: "text", text: "Hi" })]);
    expect(new TranscriptReader().read(path)?.chatUrl).toBe(URL);
  });

  test("REQ-003-43 scans once, then only what was appended; the latest URL wins", () => {
    const path = file([bridge(URL), assistant({ type: "text", text: "Hi" })]);
    const reader = new TranscriptReader();
    expect(reader.read(path)?.chatUrl).toBe(URL);
    expect(reader.scannedTo(path)).toBeGreaterThan(0);
    appendFileSync(path, `${assistant({ type: "text", text: "More" })}\n`);
    expect(reader.read(path)).toMatchObject({ chatUrl: URL, step: { text: "More" } });
    appendFileSync(path, `${bridge("https://claude.ai/code/session_02Next")}\n`);
    expect(reader.read(path)?.chatUrl).toBe("https://claude.ai/code/session_02Next");
  });

  test("REQ-003-43 no URL, or one that isn't a claude.ai session URL, gives no link", () => {
    const reader = new TranscriptReader();
    expect(reader.read(file([assistant({ type: "text", text: "Hi" })], "a.jsonl"))?.chatUrl).toBeUndefined();
    const bad = file([bridge("javascript:alert(1)"), bridge("https://evil.example/code/session_1")], "b.jsonl");
    expect(reader.read(bad)?.chatUrl).toBeUndefined();
  });
});
