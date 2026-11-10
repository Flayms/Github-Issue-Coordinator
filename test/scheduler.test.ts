import { describe, expect, test } from "bun:test";
import type { Limits } from "../src/config.ts";
import { type LiveSession, type Plan, schedule, type Work } from "../src/scheduler.ts";

const NOW = new Date("2026-11-10T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const limits = (l: Partial<Limits> = {}): Limits => ({
  maxRunning: 1,
  maxPlanners: 1,
  maxImplementers: 1,
  maxReviewers: 1,
  maxLiveSessions: 2,
  idleTimeoutMin: 30,
  maxWorktrees: 5,
  maxFeedbackRounds: 2,
  ...l,
});

const work = (key: string, w: Partial<Work> & Pick<Work, "kind">): Work => ({
  key,
  role: w.kind === "review" ? "reviewer" : w.kind === "plan" || w.kind === "revise" ? "planner" : "implementer",
  queuedAt: minsAgo(10),
  ...w,
});

const idle = (id: number, s: Partial<LiveSession> = {}): LiveSession => ({
  id,
  role: "implementer",
  state: "idle",
  lastActivityAt: minsAgo(5),
  ...s,
});
const running = (id: number, s: Partial<LiveSession> = {}): LiveSession => idle(id, { state: "running", ...s });

const run = (queue: Work[], sessions: LiveSession[] = [], l: Partial<Limits> = {}, pausedUntil?: string): Plan =>
  schedule({ queue, sessions, limits: limits(l), now: NOW, pausedUntil });

const keys = (p: Plan) => p.start.map((w) => w.key);

describe("scheduler", () => {
  test("REQ-001-08 starts work in priority order: interrupted, feedback and wake, review, implement, planning", () => {
    const queue = [
      work("plan", { kind: "plan", queuedAt: minsAgo(99) }),
      work("revise", { kind: "revise" }),
      work("impl", { kind: "implement" }),
      work("review", { kind: "review" }),
      work("wake", { kind: "wake", queuedAt: minsAgo(1) }),
      work("feedback", { kind: "feedback", queuedAt: minsAgo(2) }),
      work("interrupted", { kind: "resume-interrupted", queuedAt: minsAgo(0) }),
    ];
    const order: string[] = [];
    let q = queue;
    const big = { maxRunning: 9, maxLiveSessions: 9, maxPlanners: 9, maxImplementers: 9, maxReviewers: 9 };
    while (q.length) {
      const next = run(q, [], { ...big, maxRunning: 1 }).start[0];
      if (!next) break;
      order.push(next.key);
      q = q.filter((w) => w !== next);
    }
    expect(order).toEqual(["interrupted", "feedback", "wake", "review", "impl", "plan", "revise"]);
  });

  test("REQ-001-08 starts approved issues oldest approval first", () => {
    const queue = [
      work("new", { kind: "implement", queuedAt: minsAgo(1) }),
      work("old", { kind: "implement", queuedAt: minsAgo(50) }),
    ];
    expect(keys(run(queue))).toEqual(["old"]);
  });

  test("REQ-001-08 never exceeds a Role's Slots or the total, counting running sessions only", () => {
    const l = { maxRunning: 2, maxImplementers: 1, maxLiveSessions: 4 };
    expect(keys(run([work("a", { kind: "feedback" }), work("b", { kind: "implement" })], [], l))).toEqual(["a"]);
    expect(keys(run([work("a", { kind: "implement" }), work("r", { kind: "review" })], [], l))).toEqual(["r", "a"]);
    expect(keys(run([work("r", { kind: "review" })], [running(1), running(2, { role: "planner" })], l))).toEqual([]);
    expect(keys(run([work("r", { kind: "review" })], [running(1), idle(2, { role: "planner" })], l))).toEqual(["r"]);
  });

  test("REQ-001-08 lower-priority work for a free Role starts when the higher-priority Role is full", () => {
    const l = { maxRunning: 2, maxLiveSessions: 3 };
    expect(keys(run([work("f", { kind: "feedback" }), work("r", { kind: "review" })], [running(1)], l))).toEqual(["r"]);
  });

  test("REQ-001-08 holds back work for a session that is running, e.g. while the Owner chats with it", () => {
    const l = { maxRunning: 2, maxImplementers: 2, maxLiveSessions: 3 };
    expect(keys(run([work("f", { kind: "feedback", sessionId: 1 })], [running(1)], l))).toEqual([]);
  });

  test("REQ-001-17 starts nothing while the usage limit pause lasts, and resumes after the reset time", () => {
    const queue = [work("i", { kind: "resume-interrupted" })];
    expect(run(queue, [], {}, minsAgo(-5)).start).toEqual([]);
    expect(keys(run(queue, [], {}, minsAgo(1)))).toEqual(["i"]);
  });

  test("REQ-001-20 closes sessions idle longer than idleTimeoutMin, even while paused", () => {
    const sessions = [
      idle(1, { lastActivityAt: minsAgo(31) }),
      idle(2, { lastActivityAt: minsAgo(29) }),
      running(3, { lastActivityAt: minsAgo(90) }),
    ];
    expect(run([], sessions, { maxLiveSessions: 5 }).close).toEqual([1]);
    expect(run([], sessions, { maxLiveSessions: 5 }, minsAgo(-60)).close).toEqual([1]);
  });

  test("REQ-001-20 counts running and idle sessions toward maxLiveSessions and closes an idle one to make room", () => {
    const plan = run([work("r", { kind: "review" })], [idle(1), idle(2, { role: "planner" })]);
    expect(plan).toEqual({ close: [1], start: [expect.objectContaining({ key: "r" })] });
  });

  test("REQ-001-20 closes idle sessions while more sessions are live than allowed, even with nothing to start", () => {
    const sessions = [running(1), idle(2, { lastActivityAt: minsAgo(9) }), idle(3, { lastActivityAt: minsAgo(8) })];
    expect(run([], sessions).close).toEqual([2]);
  });

  test("REQ-001-20 never closes a running session; with no idle one to close, nothing new starts", () => {
    const l = { maxRunning: 2, maxPlanners: 2 };
    expect(run([work("p", { kind: "plan" })], [running(1), running(2, { role: "reviewer" })], l)).toEqual({
      close: [],
      start: [],
    });
  });

  test("REQ-001-20 resuming a live idle session needs no room", () => {
    const plan = run([work("f", { kind: "feedback", sessionId: 1 })], [idle(1), idle(2, { role: "planner" })]);
    expect(plan).toEqual({ close: [], start: [expect.objectContaining({ key: "f" })] });
  });

  test("REQ-001-20 does not close a session to make room when lower-priority work is about to resume it", () => {
    const plan = run(
      [work("revise", { kind: "revise", sessionId: 1 }), work("r", { kind: "review" })],
      [idle(1, { role: "planner", lastActivityAt: minsAgo(20) }), idle(2, { lastActivityAt: minsAgo(1) })],
      { maxRunning: 2 },
    );
    expect(plan).toEqual({
      close: [2],
      start: [expect.objectContaining({ key: "r" }), expect.objectContaining({ key: "revise" })],
    });
  });

  test("REQ-001-20 closes sessions waiting on the Owner first, then others, and kept-longer ones last; least recently used first", () => {
    const sessions = [
      idle(1, { lastActivityAt: minsAgo(20), keepLonger: true }),
      idle(2, { lastActivityAt: minsAgo(2) }),
      idle(3, { lastActivityAt: minsAgo(25) }),
      idle(4, { role: "planner", lastActivityAt: minsAgo(1), waitingOnOwner: true }),
      idle(5, { role: "planner", lastActivityAt: minsAgo(3), waitingOnOwner: true }),
      idle(6, { lastActivityAt: minsAgo(28), ownerMessagedAt: minsAgo(28) }),
    ];
    const closeOrder = [1, 2, 3, 4, 5, 6].map(
      (n) => run([work("r", { kind: "review" })], sessions, { maxLiveSessions: 7 - n }).close,
    );
    expect(closeOrder).toEqual([[5], [5, 4], [5, 4, 3], [5, 4, 3, 2], [5, 4, 3, 2, 6], [5, 4, 3, 2, 6, 1]]);
  });

  test("REQ-001-20 a session the Owner messaged longer ago than idleTimeoutMin is not kept longer", () => {
    const kept = [
      idle(1, { lastActivityAt: minsAgo(10), ownerMessagedAt: minsAgo(10) }),
      idle(2, { lastActivityAt: minsAgo(5) }),
    ];
    expect(run([work("r", { kind: "review" })], kept).close).toEqual([2]);
    const notKept = [
      idle(1, { lastActivityAt: minsAgo(10), ownerMessagedAt: minsAgo(40) }),
      idle(2, { lastActivityAt: minsAgo(5) }),
    ];
    expect(run([work("r", { kind: "review" })], notKept).close).toEqual([1]);
  });
});
