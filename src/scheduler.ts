/**
 * Scheduler: decides which queued work starts now and which idle sessions to close.
 * Pure; it enforces Slots (REQ-001-08), the usage-limit pause (REQ-001-17) and the
 * live-session limit and idle timeout (REQ-001-20).
 */
import type { Limits, Role } from "./config.ts";

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

export interface Plan {
  /** Store ids of idle sessions to close, in order. */
  close: number[];
  /** Work to start now, in order. */
  start: Work[];
}

export function schedule(input: {
  queue: Work[];
  sessions: LiveSession[];
  limits: Limits;
  now: Date;
  pausedUntil?: string;
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

  // REQ-001-17: nothing starts until the reported reset time.
  if (input.pausedUntil && Date.parse(input.pausedUntil) > now.getTime()) return { close, start: [] };

  const slots: Record<Role, number> = {
    planner: limits.maxPlanners,
    implementer: limits.maxImplementers,
    reviewer: limits.maxReviewers,
  };
  const runningIn = (role: Role) => [...running.values()].filter((s) => s.role === role).length;

  const queue = [...input.queue].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || Date.parse(a.queuedAt) - Date.parse(b.queuedAt),
  );
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
  for (const w of queue) {
    if (running.size >= limits.maxRunning) break;
    if (runningIn(w.role) >= slots[w.role]) continue;
    if (w.sessionId !== undefined && running.has(w.sessionId)) continue; // busy, e.g. the Owner is chatting

    const resumesLive = w.sessionId !== undefined && idle.has(w.sessionId);
    if (!resumesLive && running.size + idle.size >= limits.maxLiveSessions && !evict()) continue;

    if (resumesLive && w.sessionId !== undefined) {
      idle.delete(w.sessionId);
      reserved.delete(w.sessionId);
    }
    const id = w.sessionId ?? -(start.length + 1);
    running.set(id, { id, role: w.role, state: "running", lastActivityAt: now.toISOString() });
    start.push(w);
  }
  return { close, start };
}
