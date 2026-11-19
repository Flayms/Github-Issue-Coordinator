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
    expect(store.session(id)?.agentSessionId).toBe("abc");
  });

  test("REQ-003-42 SessionStart records the transcript path, also anew on a resume", () => {
    hook("SessionStart", { transcript_path: "/acc/a/projects/x/abc.jsonl" });
    expect(store.session(id)?.transcriptPath).toBe("/acc/a/projects/x/abc.jsonl");
    hook("SessionStart", { transcript_path: "/acc/b/projects/x/abc.jsonl" });
    expect(store.session(id)?.transcriptPath).toBe("/acc/b/projects/x/abc.jsonl");
    hook("SessionStart", { transcript_path: 42 });
    expect(store.session(id)?.transcriptPath).toBe("/acc/b/projects/x/abc.jsonl");
  });

  test("REQ-001-29 SessionStart records the model the session runs", () => {
    hook("SessionStart", { model: "claude-opus-5-5" });
    expect(store.session(id)?.modelId).toBe("claude-opus-5-5");
  });

  test("REQ-001-29 without a model in SessionStart, Stop takes it from the transcript", () => {
    hook("SessionStart");
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [] } }),
      ].join("\n"),
    );
    writeResult(validResult);
    hook("Stop", { transcript_path: transcript });
    expect(store.session(id)?.modelId).toBe("claude-sonnet-5-5");
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

  test("REQ-001-35 in a Feedback round on Review findings, a Result that does not answer every finding blocks the stop", () => {
    const f = { path: "a.ts", line: 1, severity: "high", body: "Bug" };
    store.updateIssue("octo/app", 5, { inFeedbackRound: 1, reviewFindings: JSON.stringify([f, f]) });
    writeResult({ ...validResult, responses: [{ finding: 1, answer: "fixed", reason: "Done" }] });
    const out = hook("Stop");
    expect(out.stdout && JSON.parse(out.stdout)).toEqual({ decision: "block", reason: expect.stringContaining("2") });
    writeResult({
      ...validResult,
      responses: [
        { finding: 1, answer: "fixed", reason: "Done" },
        { finding: 2, answer: "declined", reason: "Not a bug" },
      ],
    });
    expect(hook("Stop")).toEqual({});
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

  test("REQ-001-17 a turn ended by the usage limit fires StopFailure (not Stop) with error rate_limit and is marked for the pause", () => {
    // Shape seen with Claude Code 2.1.328 on a real weekly limit.
    const payload = {
      hook_event_name: "StopFailure",
      error: "rate_limit",
      last_assistant_message: "You've hit your weekly limit · resets Nov 22, 10am (UTC)",
    };
    expect(hook("StopFailure", payload)).toEqual({});
    expect(store.session(id)).toMatchObject({ state: "idle", usageLimited: true, needsSync: false, resultFailures: 0 });
  });

  /** The last transcript entries of a real weekly limit (Claude Code 2.1.328), trimmed; `resetsAt` in epoch seconds. */
  const limitTranscript = (resetsAt: unknown) => {
    const transcript = join(dir, "t.jsonl");
    const entries = [
      { type: "user", message: { content: "go" } },
      {
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "You've hit your weekly limit · resets Nov 22, 10am (UTC)" }],
        },
        apiError: "usage_limit_reached",
        apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "seven_day" } },
        error: "rate_limit",
        isApiErrorMessage: true,
      },
      { type: "last-prompt" },
      { type: "system" },
      { type: "cost-state", totalCostUSD: 0 },
    ];
    writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n"));
    return transcript;
  };
  const stopFailure = (transcript_path?: string) =>
    hook("StopFailure", {
      error: "rate_limit",
      last_assistant_message: "You've hit your weekly limit · resets Nov 22, 10am (UTC)",
      ...(transcript_path && { transcript_path }),
    });

  test("REQ-001-17 StopFailure records the reset time the transcript reports for the usage limit", () => {
    // 1795341600 = 2026-11-22 10:00 UTC, the time the message names.
    stopFailure(limitTranscript(1795341600));
    expect(store.session(id)).toMatchObject({ usageLimited: true, usageLimitResetsAt: "2026-11-22T10:00:00.000Z" });
  });

  test("REQ-001-17 the Stop fallback records the reset time too", () => {
    expect(hook("Stop", { transcript_path: limitTranscript(1795341600) })).toEqual({});
    expect(store.session(id)).toMatchObject({ usageLimited: true, usageLimitResetsAt: "2026-11-22T10:00:00.000Z" });
  });

  test("REQ-001-17 no reset time is recorded when the transcript has none that is usable", () => {
    // Missing, a string, not finite, in the past (2026-11-06, before the store's now).
    for (const resetsAt of [undefined, "1795341600", null, 1794000000]) {
      stopFailure(limitTranscript(resetsAt));
      expect(store.session(id)).toMatchObject({ usageLimited: true, usageLimitResetsAt: null });
    }
    // A transcript that is missing, unreadable, or not written yet, and a payload without one.
    stopFailure(join(dir, "missing.jsonl"));
    expect(store.session(id)?.usageLimitResetsAt).toBeNull();
    writeFileSync(join(dir, "bad.jsonl"), "not json\n{");
    stopFailure(join(dir, "bad.jsonl"));
    expect(store.session(id)?.usageLimitResetsAt).toBeNull();
    writeFileSync(join(dir, "older.jsonl"), JSON.stringify({ type: "user", message: { content: "go" } }));
    stopFailure(join(dir, "older.jsonl"));
    expect(store.session(id)?.usageLimitResetsAt).toBeNull();
    stopFailure();
    expect(store.session(id)?.usageLimitResetsAt).toBeNull();
  });

  test("REQ-001-17 a later usage limit without a reset time drops the earlier one", () => {
    stopFailure(limitTranscript(1795341600));
    stopFailure();
    expect(store.session(id)?.usageLimitResetsAt).toBeNull();
  });

  test("REQ-001-17 a turn ended by another API error is not a usage limit", () => {
    store.patchSession(id, { state: "running" });
    hook("StopFailure", { error: "overloaded" });
    expect(store.session(id)).toMatchObject({ state: "running", usageLimited: false });
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

  test("REQ-003-33 a turn's running time is recorded as agent time: a blocked stop keeps it running, a valid Result ends it", () => {
    // The step the session works on, as the Coordinator records it before resuming (a Feedback round).
    store.beginStep("octo/app", 5, { phase: "review", role: "implementer", queuedAt: now });
    const resumed = () => store.timings("octo/app", 5).filter((t) => t.kind === "agent");
    store.patchSession(id, { state: "idle" });
    now = "2026-11-10T12:05:00Z";
    store.patchSession(id, { state: "running", coordinatorPromptPending: true });
    hook("UserPromptSubmit");
    now = "2026-11-10T12:20:00Z";
    hook("Stop"); // no Result yet: blocked, still running
    expect(resumed().map((t) => t.end)).toEqual([null]);
    writeResult(validResult);
    now = "2026-11-10T12:30:00Z";
    hook("Stop");
    expect(resumed()).toMatchObject([
      { phase: "review", round: 1, start: "2026-11-10T12:05:00.000Z", end: "2026-11-10T12:30:00.000Z" },
    ]);
  });

  describe("REQ-001-67 status line", () => {
    const rateLimits = {
      five_hour: { used_percentage: 38.4, resets_at: Date.parse("2026-11-10T15:12:00Z") / 1000 },
      seven_day: { used_percentage: 24, resets_at: Date.parse("2026-11-13T09:00:00Z") / 1000 },
    };
    beforeEach(() => store.setAccount(id, "main"));

    test("stores the Account's 5-hour and weekly use with when they reset and when they were seen", () => {
      const out = hook("StatusLine", { rate_limits: rateLimits });
      expect(store.usageQuota("main")).toEqual({
        fiveHour: { usedPercent: 38.4, resetsAt: "2026-11-10T15:12:00.000Z" },
        sevenDay: { usedPercent: 24, resetsAt: "2026-11-13T09:00:00.000Z" },
        seenAt: "2026-11-10T12:00:00.000Z",
      });
      expect(out.stdout).toBe("5-hour 38% · weekly 24% used");
    });

    test("a window missing from an update keeps its last values; the other is updated", () => {
      hook("StatusLine", { rate_limits: rateLimits });
      now = "2026-11-10T12:30:00Z";
      hook("StatusLine", {
        rate_limits: { seven_day: { used_percentage: 30, resets_at: rateLimits.seven_day.resets_at } },
      });
      expect(store.usageQuota("main")).toMatchObject({
        fiveHour: { usedPercent: 38.4 },
        sevenDay: { usedPercent: 30 },
        seenAt: "2026-11-10T12:30:00.000Z",
      });
    });

    test("a missing or malformed payload changes nothing and prints nothing", () => {
      for (const payload of [
        {},
        { raw: "not json" },
        { rate_limits: null },
        { rate_limits: "full" },
        { rate_limits: { five_hour: { used_percentage: "38", resets_at: 1 } } },
        { rate_limits: { five_hour: { used_percentage: 38 } } },
        { rate_limits: { seven_day: { used_percentage: Number.NaN, resets_at: 1 } } },
        { rate_limits: { seven_day: { used_percentage: 140, resets_at: 1 } } },
      ]) {
        expect(hook("StatusLine", payload)).toEqual({});
      }
      expect(store.usageQuota("main")).toBeUndefined();
    });

    test("is stored per Account", () => {
      hook("StatusLine", { rate_limits: rateLimits });
      const other = store.createSession({ repo: "octo/app", role: "planner", kind: "issue", issues: [6] });
      store.setAccount(other, "spare");
      handleHook({
        event: "StatusLine",
        payload: { rate_limits: { five_hour: { used_percentage: 91, resets_at: rateLimits.five_hour.resets_at } } },
        store,
        sessionId: other,
        sessionDir,
      });
      expect(store.usageQuota("main")?.fiveHour?.usedPercent).toBe(38.4);
      expect(store.usageQuota("spare")).toMatchObject({ fiveHour: { usedPercent: 91 }, sevenDay: null });
    });

    test("is not appended to the hook log, since it runs after every message", () => {
      hook("StatusLine", { rate_limits: rateLimits });
      expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(false);
    });

    test("a session without a recorded Account stores nothing", () => {
      const other = store.createSession({ repo: "octo/app", role: "planner", kind: "issue", issues: [6] });
      handleHook({ event: "StatusLine", payload: { rate_limits: rateLimits }, store, sessionId: other, sessionDir });
      expect(store.usageQuota("main")).toBeUndefined();
    });
  });
});
