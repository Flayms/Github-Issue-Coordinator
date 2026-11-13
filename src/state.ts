/**
 * State derivation: from a repository's labels and the store, work out what should happen next.
 * Pure, so every rule is unit-tested; the scheduler (T5) decides when actions run.
 */
import type { Role } from "./config.ts";
import type { Actor, ChecksState, Comment, Item } from "./github/client.ts";
import { type AgentLabel, isAgentLabel } from "./labels.ts";
import type { IssueRecord, SessionRecord, WorktreeRecord } from "./store.ts";

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
  /** Closed sessions whose last turn still has to be synced; their issues are not orphaned (REQ-001-27). */
  pendingSync?: SessionRecord[];
  /** Store ids of the sessions whose tmux window is alive. */
  liveSessionIds: ReadonlySet<number>;
  /** Per issue: comments newer than the last handled one, and whether the body changed since the Planner saw it. */
  feedback?: ReadonlyMap<number, IssueFeedback>;
  /** Store records of the repository's issues (approval, Assessment). */
  records?: ReadonlyMap<number, Pick<IssueRecord, "approvedAt" | "assessment">>;
  /** Who added `agent:approved`, looked up for approved issues without an approval on record. */
  labelActors?: ReadonlyMap<number, Actor | undefined>;
  /** Worktrees on record for this repository, with the PR they belong to. */
  worktrees?: WorktreeRecord[];
  /** Head commit and checks of open agent PRs. */
  pulls?: ReadonlyMap<number, { headSha: string; checks: ChecksState; failed?: string[] }>;
  /** Per agent PR: the Owner's comments since the last handled one, and changes-requested reviews by the Owner. */
  prFeedback?: ReadonlyMap<number, { comments: Comment[]; changesRequested: { id: number; body: string }[] }>;
  maxFeedbackRounds?: number;
}

export interface IssueFeedback {
  comments: Comment[];
  bodyChanged: boolean;
}

/** `/approve`, `/agent` and `/wake` are commands; any other comment is feedback. */
export const isCommand = (body: string): boolean => /^\/(approve|agent|wake)(\s|$)/.test(body.trim());

const isWake = (body: string): boolean => /^\/wake(\s|$)/.test(body.trim());

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
  | { type: "review"; repo: string; pr: number; issues: number[]; headSha: string }
  | { type: "implement"; repo: string; issues: number[]; approvedAt: string }
  | { type: "cleanup"; repo: string; issues: number[]; prNumber: number; worktreePath: string }
  | { type: "resume-interrupted"; session: SessionRecord }
  | { type: "mark-closed"; session: SessionRecord }
  | { type: "fail"; repo: string; issues: number[]; session?: SessionRecord; pr?: number; reason: string }
  | {
      type: "feedback";
      repo: string;
      pr: number;
      issues: number[];
      text: string;
      /** Automatic rounds count toward maxFeedbackRounds; the Owner's don't (REQ-001-12). */
      counted: boolean;
      headSha: string;
      upToCommentId: number;
      upToReviewId: number;
      checksFailed: boolean;
    }
  | { type: "wake"; repo: string; issue: number; upToCommentId: number; recordNumber: number };

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
  // REQ-001-27: a closed session whose sync is still being retried counts as its session.
  const owners = [...s.sessions, ...(s.pendingSync ?? [])];
  for (const i of issues) {
    const role = IN_FLIGHT[issueState(i.labels)];
    if (role && !owners.some((x) => x.role === role && x.issues.includes(i.number)))
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

  // REQ-001-11/12/13: Feedback rounds on agent PRs; REQ-001-24: /wake.
  const withFeedback = new Set<number>();
  for (const w of s.worktrees ?? []) {
    const pull = w.prNumber !== null && open.has(w.prNumber) ? s.pulls?.get(w.prNumber) : undefined;
    if (!pull || w.prNumber === null) continue;
    if (s.sessions.some((x) => x.role === "reviewer" && x.issues.some((n) => w.issues.includes(n)))) continue;
    const f = s.prFeedback?.get(w.prNumber);
    const comments = (f?.comments ?? []).filter((x) => x.author.id === s.ownerId);
    const owner = [
      ...comments
        .filter((x) => /^\/agent(\s|$)/.test(x.body.trim()))
        .map((x) => x.body.trim().slice("/agent".length).trim()),
      ...(f?.changesRequested ?? []).map((r) => r.body.trim() || "The Owner requested changes in a review."),
    ].filter(Boolean);
    const checksFailed = pull.checks === "failure" && pull.headSha !== w.failedChecksSha;
    const auto = [
      ...(w.pendingFeedback ? [w.pendingFeedback] : []),
      ...(checksFailed
        ? [`Failing checks on ${pull.headSha}:\n\n${(pull.failed ?? []).map((x) => `- ${x}`).join("\n")}`]
        : []),
    ];
    const upToCommentId = Math.max(0, ...comments.map((x) => x.id));
    const upToReviewId = Math.max(0, ...(f?.changesRequested ?? []).map((r) => r.id));
    if (owner.length || auto.length) {
      withFeedback.add(w.prNumber);
      if (!owner.length && w.feedbackRounds >= (s.maxFeedbackRounds ?? 2))
        actions.push({
          type: "fail",
          repo: s.repo,
          issues: w.issues,
          pr: w.prNumber,
          reason: `the PR still had problems after ${w.feedbackRounds} automatic Feedback rounds`,
        });
      else
        actions.push({
          type: "feedback",
          repo: s.repo,
          pr: w.prNumber,
          issues: w.issues,
          text: [...owner, ...auto].join("\n\n"),
          counted: owner.length === 0,
          headSha: pull.headSha,
          upToCommentId,
          upToReviewId,
          checksFailed,
        });
    } else if (comments.some((x) => isWake(x.body))) {
      actions.push({ type: "wake", repo: s.repo, issue: w.issues[0] ?? 0, upToCommentId, recordNumber: w.prNumber });
    }
  }
  const handledComments = new Set(
    actions.flatMap((a) => (a.type === "approve" || a.type === "revise" ? [a.issue] : [])),
  );
  for (const i of issues) {
    const own = (s.feedback?.get(i.number)?.comments ?? []).filter((x) => x.author.id === s.ownerId);
    if (!handledComments.has(i.number) && own.some((x) => isWake(x.body)))
      actions.push({
        type: "wake",
        repo: s.repo,
        issue: i.number,
        upToCommentId: Math.max(...own.map((x) => x.id)),
        recordNumber: i.number,
      });
  }

  // REQ-001-10: an unreviewed head whose checks passed gets a Review, unless an agent is still on it (REQ-001-07).
  for (const w of s.worktrees ?? []) {
    const pull = w.prNumber !== null && open.has(w.prNumber) ? s.pulls?.get(w.prNumber) : undefined;
    if (!pull || w.prNumber === null || pull.headSha === w.reviewedHeadSha || withFeedback.has(w.prNumber)) continue;
    if (pull.checks !== "success" && pull.checks !== "none") continue;
    const busy = s.sessions.some(
      (x) =>
        x.issues.some((n) => w.issues.includes(n)) &&
        (x.role === "reviewer" || (x.role === "implementer" && x.state === "running")),
    );
    if (!busy) actions.push({ type: "review", repo: s.repo, pr: w.prNumber, issues: w.issues, headSha: pull.headSha });
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
