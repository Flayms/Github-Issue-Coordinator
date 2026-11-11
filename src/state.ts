/**
 * State derivation: from a repository's labels and the store, work out what should happen next.
 * Pure, so every rule is unit-tested; the scheduler (T5) decides when actions run.
 */
import type { Role } from "./config.ts";
import type { Actor, Comment, Item } from "./github/client.ts";
import { type AgentLabel, isAgentLabel } from "./labels.ts";
import type { IssueRecord, SessionRecord } from "./store.ts";

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
  /** Current time (ISO), for approvals by label. */
  now?: string;
  repo: string;
  ownerId: number;
  items: Item[];
  /** Open (running or idle) sessions of this repository, from the store. */
  sessions: SessionRecord[];
  /** Store ids of the sessions whose tmux window is alive. */
  liveSessionIds: ReadonlySet<number>;
  /** Per issue: comments newer than the last handled one, and whether the body changed since the Planner saw it. */
  feedback?: ReadonlyMap<number, IssueFeedback>;
  /** Store records of the repository's issues (approval, Assessment). */
  records?: ReadonlyMap<number, Pick<IssueRecord, "approvedAt" | "assessment">>;
  /** Who added `agent:approved`, looked up for approved issues without an approval on record. */
  labelActors?: ReadonlyMap<number, Actor | undefined>;
  /** Worktrees on record for this repository, with the PR they belong to. */
  worktrees?: { issues: number[]; prNumber: number | null; worktreePath: string }[];
}

export interface IssueFeedback {
  comments: Comment[];
  bodyChanged: boolean;
}

/** `/approve`, `/agent` and `/wake` are commands; any other comment is feedback. */
export const isCommand = (body: string): boolean => /^\/(approve|agent|wake)(\s|$)/.test(body.trim());

const PROPOSALS: IssueState[] = ["proposed", "needs-refinement", "wontfix-proposed"];

export type Action =
  | { type: "plan"; repo: string; issues: number[] }
  | { type: "revise"; repo: string; issue: number; comments: Comment[]; bodyChanged: boolean }
  | { type: "approve"; repo: string; issue: number; notes: string; at: string; upToCommentId: number }
  | { type: "reject-approval"; repo: string; issue: number }
  | { type: "block"; repo: string; issue: number; blockers: number[] }
  | { type: "unblock"; repo: string; issue: number }
  | { type: "implement"; repo: string; issues: number[]; approvedAt: string }
  | { type: "cleanup"; repo: string; issues: number[]; prNumber: number; worktreePath: string }
  | { type: "implement"; repo: string; issues: number[]; approvedAt: string }
  | { type: "cleanup"; repo: string; issues: number[]; prNumber: number; worktreePath: string }
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

  // REQ-001-04 / REQ-001-03: on a proposal, the Owner's /approve approves it; other feedback revises the plan.
  for (const i of issues) {
    const state = issueState(i.labels);
    if (!PROPOSALS.includes(state)) continue;
    const f = s.feedback?.get(i.number);
    const own = (f?.comments ?? []).filter((c) => c.author.id === s.ownerId);
    const approval = state === "proposed" ? own.findLast((c) => /^\/approve(\s|$)/.test(c.body.trim())) : undefined;
    const comments = own.filter((c) => !isCommand(c.body));
    if (approval) {
      const notes = [...comments.map((c) => c.body), approval.body.trim().slice("/approve".length).trim()];
      actions.push({
        type: "approve",
        repo: s.repo,
        issue: i.number,
        notes: notes.filter(Boolean).join("\n\n"),
        at: approval.createdAt,
        upToCommentId: Math.max(...own.map((c) => c.id)),
      });
    } else if (comments.length > 0 || f?.bodyChanged)
      actions.push({ type: "revise", repo: s.repo, issue: i.number, comments, bodyChanged: f?.bodyChanged ?? false });
  }

  // REQ-001-04: the approved label counts only when the Owner added it. REQ-001-05: blocked issues wait.
  const open = new Set(s.items.map((i) => i.number));
  for (const i of issues) {
    const state = issueState(i.labels);
    if (state !== "approved" && state !== "blocked") continue;
    const rec = s.records?.get(i.number);
    if (!rec?.approvedAt) {
      if (state !== "approved" || !s.labelActors?.has(i.number)) continue;
      if (s.labelActors.get(i.number)?.id === s.ownerId)
        actions.push({
          type: "approve",
          repo: s.repo,
          issue: i.number,
          notes: "",
          at: s.now ?? new Date().toISOString(),
          upToCommentId: 0,
        });
      else actions.push({ type: "reject-approval", repo: s.repo, issue: i.number });
      continue;
    }
    const blockers = coordination(rec.assessment, "blockedBy").filter((n) => open.has(n));
    if (state === "approved" && blockers.length)
      actions.push({ type: "block", repo: s.repo, issue: i.number, blockers });
    if (state === "blocked" && !blockers.length) actions.push({ type: "unblock", repo: s.repo, issue: i.number });
  }

  // REQ-001-09 / REQ-001-06: approved, unblocked issues start an Implementer, together with their Bundle.
  const bundled = new Set<number>();
  for (const i of [...issues].sort((a, b) => a.number - b.number)) {
    const rec = s.records?.get(i.number);
    if (issueState(i.labels) !== "approved" || !rec?.approvedAt || bundled.has(i.number)) continue;
    if (coordination(rec.assessment, "blockedBy").some((n) => open.has(n))) continue;
    const joinable = (n: number) => {
      const other = issues.find((x) => x.number === n);
      return other !== undefined && ["proposed", "approved"].includes(issueState(other.labels));
    };
    const members = [...new Set([i.number, ...coordination(rec.assessment, "bundleWith").filter(joinable)])].sort(
      (a, b) => a - b,
    );
    for (const n of members) bundled.add(n);
    const approvedAt = members
      .map((n) => s.records?.get(n)?.approvedAt)
      .filter((t): t is string => !!t)
      .sort()[0] as string;
    actions.push({ type: "implement", repo: s.repo, issues: members, approvedAt });
  }

  // REQ-001-14: a Worktree whose PR was merged or closed is cleaned up.
  for (const w of s.worktrees ?? []) {
    if (w.prNumber !== null && !open.has(w.prNumber))
      actions.push({
        type: "cleanup",
        repo: s.repo,
        issues: w.issues,
        prNumber: w.prNumber,
        worktreePath: w.worktreePath,
      });
  }

  // REQ-001-02: one Planner pass over all new issues.
  const fresh = issues.filter((i) => issueState(i.labels) === "new").map((i) => i.number);
  if (fresh.length > 0) actions.push({ type: "plan", repo: s.repo, issues: fresh });

  return actions;
}

function coordination(assessment: string | null, key: "blockedBy" | "bundleWith"): number[] {
  if (!assessment) return [];
  try {
    const list = (JSON.parse(assessment) as Record<string, unknown>)[key];
    return Array.isArray(list) ? list.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

const fail = (session: SessionRecord, reason: string): Action => ({
  type: "fail",
  repo: session.repo,
  issues: session.issues,
  session,
  reason,
});
