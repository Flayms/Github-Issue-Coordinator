/**
 * Scheduler: decides which queued work starts now and which idle sessions to close.
 * Pure; it enforces Slots (REQ-001-08), the usage-limit pause (REQ-001-17) and the
 * live-session limit and idle timeout (REQ-001-20).
 */
import type { Limits, Role } from "./config.ts";
import type { HarnessName } from "./harness/harness.ts";

export type WorkKind = "resume-interrupted" | "feedback" | "wake" | "review" | "implement" | "plan" | "revise";

/** Lower starts first (REQ-001-08). */
const RANK: Record<WorkKind, number> = {
  "resume-interrupted": 0,
  feedback: 1,
  wake: 1,
  review: 2,
  implement: 3,
  plan: 4,
  revise: 4,
};

export interface Work {
  /** Identifies the work, e.g. `octo/app#5 feedback`. */
  key: string;
  kind: WorkKind;
  role: Role;
  /** When it was queued; for `implement`, when the issue was approved. */
  queuedAt: string;
  /** Store id of the session this work resumes; absent for a fresh session. */
  sessionId?: number;
  /** The Harness the work runs on (REQ-006-01); absent: Claude Code. */
  harness?: HarnessName;
}

export interface LiveSession {
  /** Store id. */
  id: number;
  role: Role;
  state: "running" | "idle";
  lastActivityAt: string;
  /** A Planner waiting for the Owner's decision on GitHub: closed first. */
  waitingOnOwner?: boolean;
  /** An Implementer whose PR is still in Feedback rounds: closed last. */
  keepLonger?: boolean;
  /** Last time the Owner sent the session a message; recent ones are closed last. */
  ownerMessagedAt?: string | null;
}

/** Why queued work does not start (REQ-003-04). `max-worktrees` is found out by the implement job itself. */
export type WaitReason =
  | { kind: "paused"; until: string }
  | { kind: "max-running" }
  | { kind: "slot"; role: Role }
  | { kind: "session-busy" }
  | { kind: "max-live-sessions" }
  | { kind: "max-worktrees" };

export interface Queued {
  work: Work;
  /** Absent when the work starts now. */
  wait?: WaitReason;
}

export interface Plan {
  /** Store ids of idle sessions to close, in order. */
  close: number[];
  /** Work to start now, in order. */
  start: Work[];
  /** The whole queue in priority order, for the dashboard (REQ-003-04). */
  queue: Queued[];
}

export function schedule(input: {
  queue: Work[];
  sessions: LiveSession[];
  limits: Limits;
  now: Date;
  /** Set while every Account is paused by a usage limit: when the first is free again (REQ-001-17). */
  pausedUntil?: string;
  /** REQ-006-02: per Harness, while every Account of it is paused: when the first is free again. */
  pausedUntilFor?: Partial<Record<HarnessName, string>>;
}): Plan {
  const { limits, now } = input;
  const timeoutMs = limits.idleTimeoutMin * 60_000;
  const age = (iso: string) => now.getTime() - Date.parse(iso);

  const close: number[] = [];
  const idle = new Map<number, LiveSession>();
  const running = new Map<number, LiveSession>();
  for (const s of input.sessions) {
    if (s.state === "running") running.set(s.id, s);
    else if (age(s.lastActivityAt) > timeoutMs) close.push(s.id);
    else idle.set(s.id, s);
  }

  const queue = [...input.queue].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || Date.parse(a.queuedAt) - Date.parse(b.queuedAt),
  );

  // REQ-001-17: while every Account is paused, nothing starts until the first one is free again.
  const { pausedUntil } = input;
  if (pausedUntil && Date.parse(pausedUntil) > now.getTime())
    return { close, start: [], queue: queue.map((work) => ({ work, wait: { kind: "paused", until: pausedUntil } })) };
  // REQ-006-02: the same per Harness; work of another Harness goes on.
  const pausedFor = (w: Work): string | undefined => {
    const until = input.pausedUntilFor?.[w.harness ?? "claude"];
    return until && Date.parse(until) > now.getTime() ? until : undefined;
  };

  const slots: Record<Role, number> = {
    planner: limits.maxPlanners,
    implementer: limits.maxImplementers,
    reviewer: limits.maxReviewers,
  };
  const runningIn = (role: Role) => [...running.values()].filter((s) => s.role === role).length;

  // Sessions about to be resumed must not be closed to make room.
  const reserved = new Set(
    queue.flatMap((w) => (w.sessionId !== undefined && idle.has(w.sessionId) ? [w.sessionId] : [])),
  );

  const evictionGroup = (s: LiveSession) => {
    const ownerRecent = s.ownerMessagedAt != null && age(s.ownerMessagedAt) <= timeoutMs;
    if (s.keepLonger || ownerRecent) return 2;
    return s.waitingOnOwner ? 0 : 1;
  };
  const nextToClose = () =>
    [...idle.values()]
      .filter((s) => !reserved.has(s.id))
      .sort(
        (a, b) => evictionGroup(a) - evictionGroup(b) || Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt),
      )[0];

  const evict = (): boolean => {
    const victim = nextToClose();
    if (!victim) return false;
    idle.delete(victim.id);
    close.push(victim.id);
    return true;
  };
  while (running.size + idle.size > limits.maxLiveSessions && evict()) {}

  const start: Work[] = [];
  const listed: Queued[] = [];
  for (const w of queue) {
    const wait = (reason: WaitReason) => listed.push({ work: w, wait: reason });
    const paused = pausedFor(w);
    if (paused) {
      wait({ kind: "paused", until: paused });
      continue;
    }
    if (running.size >= limits.maxRunning) {
      wait({ kind: "max-running" });
      continue;
    }
    if (runningIn(w.role) >= slots[w.role]) {
      wait({ kind: "slot", role: w.role });
      continue;
    }
    // Busy, e.g. the Owner is chatting.
    if (w.sessionId !== undefined && running.has(w.sessionId)) {
      wait({ kind: "session-busy" });
      continue;
    }

    const resumesLive = w.sessionId !== undefined && idle.has(w.sessionId);
    if (!resumesLive && running.size + idle.size >= limits.maxLiveSessions && !evict()) {
      wait({ kind: "max-live-sessions" });
      continue;
    }

    if (resumesLive && w.sessionId !== undefined) {
      idle.delete(w.sessionId);
      reserved.delete(w.sessionId);
    }
    const id = w.sessionId ?? -(start.length + 1);
    running.set(id, { id, role: w.role, state: "running", lastActivityAt: now.toISOString() });
    start.push(w);
    listed.push({ work: w });
  }
  return { close, start, queue: listed };
}
