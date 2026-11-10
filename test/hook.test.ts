import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHook } from "../src/hook.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let id: number;
let sessionDir: string;
let now: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-"));
  now = "2026-11-10T12:00:00Z";
  store = new Store(join(dir, "state.db"), () => new Date(now));
  id = store.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
  store.patchSession(id, { coordinatorPromptPending: true });
  sessionDir = join(dir, "sessions", String(id));
  mkdirSync(sessionDir, { recursive: true });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true });
});

const hook = (event: string, payload: Record<string, unknown> = {}) =>
  handleHook({ event, payload: { session_id: "sess-1", ...payload }, store, sessionId: id, sessionDir });
const writeResult = (r: unknown) => writeFileSync(join(sessionDir, "result.json"), JSON.stringify(r));
const validResult = { prTitle: "T", prBody: "B", summary: "S" };

describe("hook", () => {
  test("REQ-001-18 SessionStart records Claude's session id for resuming", () => {
    hook("SessionStart", { session_id: "abc" });
    expect(store.session(id)?.claudeSessionId).toBe("abc");
  });

  test("REQ-001-19 the Coordinator's own prompt is not counted as the Owner's", () => {
    hook("UserPromptSubmit");
    expect(store.session(id)).toMatchObject({
      state: "running",
      coordinatorPromptPending: false,
      ownerMessagedAt: null,
    });
  });

  test("REQ-001-19 a later prompt is the Owner's and marks the session running", () => {
    hook("UserPromptSubmit");
    writeResult(validResult);
    hook("Stop");
    now = "2026-11-10T12:10:00Z";
    hook("UserPromptSubmit");
    expect(store.session(id)).toMatchObject({ state: "running", ownerMessagedAt: "2026-11-10T12:10:00.000Z" });
  });

  test("REQ-001-19 a turn that ends with a valid Result marks the session idle and queues a sync", () => {
    writeResult(validResult);
    expect(hook("Stop")).toEqual({});
    expect(store.session(id)).toMatchObject({ state: "idle", needsSync: true, resultFailures: 0 });
  });

  test("REQ-001-21 an invalid Result blocks the stop with an instruction, and the session keeps running", () => {
    const out = hook("Stop");
    expect(out.stdout && JSON.parse(out.stdout)).toEqual({
      decision: "block",
      reason: expect.stringMatching(/^The Result file is missing\. Before ending your turn, write .*result\.json/),
    });
    expect(store.session(id)).toMatchObject({ state: "running", resultFailures: 1, needsSync: false });
  });

  test("REQ-001-21 Claude's own stop_hook_active retry still counts toward the limit, and after 3 failures the turn ends", () => {
    hook("Stop");
    hook("Stop", { stop_hook_active: true });
    hook("Stop", { stop_hook_active: true });
    expect(store.session(id)?.resultFailures).toBe(3);
    expect(hook("Stop", { stop_hook_active: true })).toEqual({});
    expect(store.session(id)).toMatchObject({ state: "idle", resultFailures: 3, needsSync: true });
  });

  test("REQ-001-21 a valid Result resets the failure count", () => {
    hook("Stop");
    writeResult(validResult);
    hook("Stop", { stop_hook_active: true });
    expect(store.session(id)?.resultFailures).toBe(0);
  });

  test("REQ-001-17 a turn cut off by the usage limit is not blocked and is marked for the pause", () => {
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        { type: "user", message: { content: "go" } },
        {
          type: "assistant",
          isApiErrorMessage: true,
          message: { content: [{ type: "text", text: "Claude usage limit reached. Your limit will reset at 3pm." }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    expect(hook("Stop", { transcript_path: transcript })).toEqual({});
    expect(store.session(id)).toMatchObject({ state: "idle", usageLimited: true, needsSync: false, resultFailures: 0 });
  });

  test("an agent merely talking about limits is not a usage limit", () => {
    const transcript = join(dir, "t.jsonl");
    const text = "I raised the usage limit reached threshold.";
    writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
    hook("Stop", { transcript_path: transcript });
    expect(store.session(id)?.usageLimited).toBe(false);
  });

  test("T0 (e) logs every hook payload so unknown shapes can be captured", () => {
    hook("Notification", { message: "something new" });
    const log = readFileSync(join(sessionDir, "events.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(log.at(-1) ?? "{}")).toMatchObject({
      event: "Notification",
      payload: { message: "something new" },
    });
  });

  test("an unknown session id does nothing and never throws", () => {
    expect(handleHook({ event: "Stop", payload: {}, store, sessionId: 999, sessionDir })).toEqual({});
    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(true);
  });
});
