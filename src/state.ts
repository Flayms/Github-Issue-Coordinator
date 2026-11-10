/**
 * State derivation: from a repository's labels and the store, work out what should happen next.
 * Pure, so every rule is unit-tested; the scheduler (T5) decides when actions run.
 */
import type { Role } from "./config.ts";
import type { Item } from "./github/client.ts";
import { type AgentLabel, isAgentLabel } from "./labels.ts";
import type { SessionRecord } from "./store.ts";

export type IssueState = "new" | (AgentLabel extends `agent:${infer S}` ? S : never);

/** When several agent labels are present, the most advanced one wins. */
const PRECEDENCE: IssueState[] = [
  "failed",
  "reviewing",
  "reviewed",
  "pr-open",
  "in-progress",
  "blocked",
  "approved",
  "planning",
  "proposed",
  "needs-refinement",
  "wontfix-proposed",
];

export function issueState(labels: string[]): IssueState {
  const present = new Set(labels.filter(isAgentLabel).map((l) => l.slice("agent:".length) as IssueState));
  return PRECEDENCE.find((s) => present.has(s)) ?? "new";
}

/** States in which a session of this Role is supposed to be working on the issue (REQ-001-07). */
const IN_FLIGHT: Partial<Record<IssueState, Role>> = {
  planning: "planner",
  "in-progress": "implementer",
  reviewing: "reviewer",
};

export interface Snapshot {
  repo: string;
  ownerId: number;
  items: Item[];
  /** Open (running or idle) sessions of this repository, from the store. */
  sessions: SessionRecord[];
  /** Store ids of the sessions whose tmux window is alive. */
  liveSessionIds: ReadonlySet<number>;
}

export type Action =
  | { type: "plan"; repo: string; issues: number[] }
  | { type: "resume-interrupted"; session: SessionRecord }
  | { type: "mark-closed"; session: SessionRecord }
  | { type: "fail"; repo: string; issues: number[]; session?: SessionRecord; reason: string };

export function deriveActions(s: Snapshot): Action[] {
  const actions: Action[] = [];
  // REQ-001-01: only the Owner's issues are in scope. Agent PRs are tracked through the store.
  const issues = s.items.filter((i) => !i.isPullRequest && i.author.id === s.ownerId);

  // REQ-001-16: open sessions without a live window were cut off by a restart or crash.
  for (const session of s.sessions) {
    if (s.liveSessionIds.has(session.id)) continue;
    if (session.state === "idle") actions.push({ type: "mark-closed", session });
    else if (session.claudeSessionId === null)
      actions.push(fail(session, "session never reported its id, so it cannot be resumed"));
    else if (session.resumeAttempts >= 1)
      actions.push(fail(session, "session was interrupted again after being resumed once"));
    else actions.push({ type: "resume-interrupted", session });
  }

  // REQ-001-07 / REQ-001-16: an in-flight label needs its session; never start a second one.
  for (const i of issues) {
    const role = IN_FLIGHT[issueState(i.labels)];
    if (role && !s.sessions.some((x) => x.role === role && x.issues.includes(i.number)))
      actions.push({ type: "fail", repo: s.repo, issues: [i.number], reason: `no ${role} session to resume` });
  }

  // REQ-001-02: one Planner pass over all new issues.
  const fresh = issues.filter((i) => issueState(i.labels) === "new").map((i) => i.number);
  if (fresh.length > 0) actions.push({ type: "plan", repo: s.repo, issues: fresh });

  return actions;
}

const fail = (session: SessionRecord, reason: string): Action => ({
  type: "fail",
  repo: session.repo,
  issues: session.issues,
  session,
  reason,
});
