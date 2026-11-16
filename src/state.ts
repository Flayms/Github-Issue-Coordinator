/**
 * State derivation: from a repository's labels and the store, work out what should happen next.
 * Pure, so every rule is unit-tested; the scheduler (T5) decides when actions run.
 */
import type { Role } from "./config.ts";
import type { Actor, ChecksState, Comment, Item, OpenPull, PullStatus } from "./github/client.ts";
import { type AgentLabel, isAgentLabel } from "./labels.ts";
import type { IssueRecord, SessionRecord, WorktreeRecord } from "./store.ts";

export type { OpenPull };

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
  /** Split-off issues on record (REQ-001-34); in scope although the Coordinator authored them. */
  splitOffs?: ReadonlySet<number>;
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
  /**
   * Head commit, checks, mergeability and state of the agent PRs on record, fetched one by one: a PR
   * missing from `items` (cached or lagging list) may still be open (REQ-001-14). Missing here when
   * the fetch failed, so nothing is decided about that PR on this tick.
   */
  pulls?: ReadonlyMap<number, PullState>;
  /** Open PRs of the repository with their head branch, to find agent PRs without a Worktree on record (REQ-001-42/43). */
  openPulls?: OpenPull[];
  /** Per agent PR: the Owner's comments since the last handled one, and changes-requested reviews by the Owner. */
  prFeedback?: ReadonlyMap<number, { comments: Comment[]; changesRequested: { id: number; body: string }[] }>;
  maxFeedbackRounds?: number;
  /** How long after a head appeared "no checks" still means CI may not have registered yet (REQ-001-10). */
  checksGraceSeconds?: number;
}

export interface PullState {
  headSha: string;
  checks: ChecksState;
  failed?: string[];
  /** GitHub's `mergeable`: false means merge conflicts, null that GitHub is still computing it (REQ-001-28). */
  mergeable: boolean | null;
  /** When the Coordinator first saw this head commit (ISO). */
  headSeenAt: string;
  /** The PR's base branch, normally the default branch. */
  baseRef?: string;
  /** As GitHub reports it for the PR itself (REQ-001-14). */
  state: PullStatus;
}

export interface IssueFeedback {
  comments: Comment[];
  bodyChanged: boolean;
}

/** `/approve`, `/agent` and `/wake` are commands; any other comment is feedback. */
export const isCommand = (body: string): boolean => /^\/(approve|agent|wake)(\s|$)/.test(body.trim());

const isWake = (body: string): boolean => /^\/wake(\s|$)/.test(body.trim());

const PROPOSALS: IssueState[] = ["proposed", "needs-refinement", "wontfix-proposed"];

/** REQ-001-01 / REQ-001-34: an issue the Owner authored, or one the Coordinator split off from one. */
export const inScope = (i: Item, ownerId: number, splitOffs: ReadonlySet<number> = new Set()): boolean =>
  !i.isPullRequest && (i.author.id === ownerId || splitOffs.has(i.number));

/** Why an automatic Feedback round runs; a round that ends without new commits reports them (REQ-001-38). */
export type FeedbackCause = "findings" | "checks" | "conflicts";

export type Action =
  | { type: "plan"; repo: string; issues: number[] }
  | { type: "revise"; repo: string; issue: number; comments: Comment[]; bodyChanged: boolean }
  | {
      type: "approve";
      repo: string;
      issue: number;
      notes: string;
      at: string;
      upToCommentId: number;
      /** Open issues it is blocked by: then it goes straight to `agent:blocked` (REQ-001-05). */
      blockers: number[];
    }
  | { type: "reject-approval"; repo: string; issue: number }
  | { type: "block"; repo: string; issue: number; blockers: number[] }
  | { type: "unblock"; repo: string; issue: number }
  | { type: "implement"; repo: string; issues: number[]; approvedAt: string }
  | { type: "cleanup"; repo: string; issues: number[]; prNumber: number; worktreePath: string }
  | { type: "review"; repo: string; pr: number; issues: number[]; headSha: string }
  | { type: "implement"; repo: string; issues: number[]; approvedAt: string }
  | { type: "cleanup"; repo: string; issues: number[]; prNumber: number; worktreePath: string }
  /** REQ-001-43: rebuild the Worktree of an orphaned agent PR from its branch and record the PR again. */
  | { type: "reattach"; repo: string; pr: number; branch: string; issues: number[] }
  /** REQ-001-43: an orphaned agent PR whose issues are all closed or out of scope; only logged. */
  | { type: "orphan-closed"; repo: string; pr: number; issues: number[] }
  | { type: "resume-interrupted"; session: SessionRecord }
  | { type: "mark-closed"; session: SessionRecord }
  | {
      type: "fail";
      repo: string;
      issues: number[];
      session?: SessionRecord;
      pr?: number;
      reason: string;
      /** Past maxFeedbackRounds: the head whose failing checks or conflicts are given up on, once (REQ-001-13/28). */
      headSha?: string;
      checksFailed?: boolean;
      conflicted?: boolean;
    }
  | {
      type: "feedback";
      repo: string;
      pr: number;
      issues: number[];
      text: string;
      /** Automatic rounds on findings or checks count toward maxFeedbackRounds; conflict rounds and the Owner's don't (REQ-001-12/28). */
      counted: boolean;
      /** Causes of an automatic round; empty for a round the Owner started (REQ-001-38). */
      causes: FeedbackCause[];
      headSha: string;
      upToCommentId: number;
      upToReviewId: number;
      checksFailed: boolean;
      /** The PR has merge conflicts (REQ-001-28, REQ-001-37): the default branch has to be fetched into the Worktree first. */
      conflicted: boolean;
    }
  | { type: "wake"; repo: string; issue: number; upToCommentId: number; recordNumber: number };

export function deriveActions(s: Snapshot): Action[] {
  const actions: Action[] = [];
  // REQ-001-01: only the Owner's issues and Split-off issues (REQ-001-34) are in scope. Agent PRs are tracked through the store.
  const issues = s.items.filter((i) => inScope(i, s.ownerId, s.splitOffs));

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
  // REQ-001-39: an Implementer issue with Review findings on record waits for its Feedback round below.
  const owners = [...s.sessions, ...(s.pendingSync ?? [])];
  const awaitingRound = (n: number) => (s.worktrees ?? []).some((w) => w.pendingFeedback && w.issues.includes(n));

  // REQ-001-42: issues with an open agent PR are never planned or implemented again.
  const agent = agentPulls(s.repo, s.openPulls ?? []);
  const withPull = new Set(agent.flatMap((p) => p.issues));

  // REQ-001-43: an open agent PR without a Worktree on record for any of its issues, and no session
  // on them, is re-attached; one whose issues are all closed or out of scope is only reported.
  // Queued after the other actions, but known here: a stale in-flight label on an issue being
  // re-attached is replaced, so it must not fail the issue.
  const ours = new Set(issues.map((i) => i.number));
  const busyIssue = (n: number) => owners.some((x) => x.issues.includes(n));
  const orphans: Action[] = [];
  for (const p of agent) {
    const recorded = (s.worktrees ?? []).some(
      (w) => w.prNumber === p.number || w.issues.some((n) => p.issues.includes(n)),
    );
    if (recorded || p.issues.some(busyIssue)) continue;
    const attach = p.issues.filter((n) => ours.has(n));
    if (attach.length)
      orphans.push({ type: "reattach", repo: s.repo, pr: p.number, branch: p.headRef, issues: attach });
    else orphans.push({ type: "orphan-closed", repo: s.repo, pr: p.number, issues: p.issues });
  }
  const reattaching = new Set(orphans.flatMap((a) => (a.type === "reattach" ? a.issues : [])));

  for (const i of issues) {
    const role = IN_FLIGHT[issueState(i.labels)];
    if (role === "implementer" && awaitingRound(i.number)) continue;
    if (reattaching.has(i.number)) continue; // REQ-001-43
    if (role && !owners.some((x) => x.role === role && x.issues.includes(i.number)))
      actions.push({ type: "fail", repo: s.repo, issues: [i.number], reason: `no ${role} session to resume` });
  }

  // REQ-001-05: the open issues an issue's Assessment says it is blocked by.
  const open = new Set(s.items.map((i) => i.number));
  const openBlockers = (n: number) =>
    coordination(s.records?.get(n)?.assessment ?? null, "blockedBy").filter((b) => open.has(b));

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
        blockers: openBlockers(i.number),
      });
    } else if (comments.length > 0 || f?.bodyChanged)
      actions.push({ type: "revise", repo: s.repo, issue: i.number, comments, bodyChanged: f?.bodyChanged ?? false });
  }

  // REQ-001-04: the approved label counts only when the Owner added it. REQ-001-05: blocked issues wait.
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
          blockers: openBlockers(i.number),
        });
      else actions.push({ type: "reject-approval", repo: s.repo, issue: i.number });
      continue;
    }
    const blockers = openBlockers(i.number);
    if (state === "approved" && blockers.length)
      actions.push({ type: "block", repo: s.repo, issue: i.number, blockers });
    if (state === "blocked" && !blockers.length) actions.push({ type: "unblock", repo: s.repo, issue: i.number });
  }

  // REQ-001-09 / REQ-001-06: approved, unblocked issues start an Implementer, together with their Bundle.
  const bundled = new Set<number>();
  for (const i of [...issues].sort((a, b) => a.number - b.number)) {
    const rec = s.records?.get(i.number);
    if (issueState(i.labels) !== "approved" || !rec?.approvedAt || bundled.has(i.number)) continue;
    if (withPull.has(i.number)) continue; // REQ-001-42
    if (coordination(rec.assessment, "blockedBy").some((n) => open.has(n))) continue;
    const joinable = (n: number) => {
      const other = issues.find((x) => x.number === n);
      return other !== undefined && !withPull.has(n) && ["proposed", "approved"].includes(issueState(other.labels));
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
    const pull = openPull(s, w);
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
    // REQ-001-28: GitHub runs no checks on a conflicted PR, so conflicts need their own round.
    // Automatic rounds stop once the issue failed; only the Owner's rounds run then (REQ-001-37).
    const failed = w.issues.some((n) => issueState(s.items.find((i) => i.number === n)?.labels ?? []) === "failed");
    const findings = !failed && w.pendingFeedback ? w.pendingFeedback : null;
    const checksFailed = !failed && pull.checks === "failure" && pull.headSha !== w.failedChecksSha;
    const newConflict = !failed && pull.mergeable === false && pull.headSha !== w.conflictSha;
    const causes: FeedbackCause[] = [
      ...(findings ? (["findings"] as const) : []),
      ...(checksFailed ? (["checks"] as const) : []),
      ...(newConflict ? (["conflicts"] as const) : []),
    ];
    // REQ-001-37: any round on a conflicting PR, the Owner's too, fetches the default branch and asks for the merge.
    const conflicted = pull.mergeable === false && (newConflict || owner.length > 0);
    const auto = [
      ...(findings ? [findings] : []),
      ...(checksFailed
        ? [`Failing checks on ${pull.headSha}:\n\n${(pull.failed ?? []).map((x) => `- ${x}`).join("\n")}`]
        : []),
      ...(conflicted ? [conflictText(pull.baseRef)] : []),
    ];
    const upToCommentId = Math.max(0, ...comments.map((x) => x.id));
    const upToReviewId = Math.max(0, ...(f?.changesRequested ?? []).map((r) => r.id));
    // REQ-001-28: merge conflicts are not the agent's fault, so only findings and checks count.
    const counted = !owner.length && (findings !== null || checksFailed);
    if (owner.length || auto.length) {
      withFeedback.add(w.prNumber);
      if (counted && w.feedbackRounds >= (s.maxFeedbackRounds ?? 2))
        actions.push({
          type: "fail",
          repo: s.repo,
          issues: w.issues,
          pr: w.prNumber,
          reason: `the PR still had problems after ${w.feedbackRounds} automatic Feedback rounds`,
          headSha: pull.headSha,
          checksFailed,
          conflicted,
        });
      else
        actions.push({
          type: "feedback",
          repo: s.repo,
          pr: w.prNumber,
          issues: w.issues,
          text: [...owner, ...auto].join("\n\n"),
          counted,
          causes: owner.length ? [] : causes,
          headSha: pull.headSha,
          upToCommentId,
          upToReviewId,
          checksFailed,
          conflicted,
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

  // REQ-001-10: an unreviewed, mergeable head whose checks passed gets a Review, unless an agent is still on it
  // (REQ-001-07). "No checks" counts only after a grace period, since CI registers its runs a little after a push.
  const now = Date.parse(s.now ?? new Date().toISOString());
  const graceMs = (s.checksGraceSeconds ?? 120) * 1000;
  for (const w of s.worktrees ?? []) {
    const pull = openPull(s, w);
    if (!pull || w.prNumber === null || pull.headSha === w.reviewedHeadSha || withFeedback.has(w.prNumber)) continue;
    if (pull.mergeable !== true) continue; // REQ-001-28
    if (pull.checks !== "success" && pull.checks !== "none") continue;
    if (pull.checks === "none" && now - Date.parse(pull.headSeenAt) < graceMs) continue;
    const busy = s.sessions.some(
      (x) =>
        x.issues.some((n) => w.issues.includes(n)) &&
        (x.role === "reviewer" || (x.role === "implementer" && x.state === "running")),
    );
    if (!busy) actions.push({ type: "review", repo: s.repo, pr: w.prNumber, issues: w.issues, headSha: pull.headSha });
  }

  // REQ-001-14: a Worktree whose PR GitHub reports as merged or closed is cleaned up. Missing from the
  // list of open items is not enough: the list may be cached (304) or lag behind a PR just opened.
  for (const w of s.worktrees ?? []) {
    const state = w.prNumber === null ? undefined : s.pulls?.get(w.prNumber)?.state;
    if (w.prNumber !== null && (state === "closed" || state === "merged"))
      actions.push({
        type: "cleanup",
        repo: s.repo,
        issues: w.issues,
        prNumber: w.prNumber,
        worktreePath: w.worktreePath,
      });
  }

  actions.push(...orphans);

  // REQ-001-02: one Planner pass over all new issues; REQ-001-42: not those with an open agent PR.
  const fresh = issues.filter((i) => issueState(i.labels) === "new" && !withPull.has(i.number)).map((i) => i.number);
  if (fresh.length > 0) actions.push({ type: "plan", repo: s.repo, issues: fresh });

  return actions;
}

/** Closing keywords GitHub understands, followed by an issue of the same repository. */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi;

/**
 * REQ-001-42: open PRs from an `agent/<n>-…` branch of this repository (never a fork), with the
 * issues each is named after or closes, sorted.
 */
export function agentPulls(repo: string, pulls: OpenPull[]): { number: number; headRef: string; issues: number[] }[] {
  return pulls.flatMap((p) => {
    const named = /^agent\/(\d+)-/.exec(p.headRef)?.[1];
    if (named === undefined || p.headRepo?.toLowerCase() !== repo.toLowerCase()) return [];
    const closes = [...p.body.matchAll(CLOSES)].map((m) => Number(m[1]));
    const issues = [...new Set([Number(named), ...closes])].sort((a, b) => a - b);
    return [{ number: p.number, headRef: p.headRef, issues }];
  });
}

/** The PR of a Worktree, if GitHub reports it open (REQ-001-14). */
const openPull = (s: Snapshot, w: WorktreeRecord): PullState | undefined => {
  const pull = w.prNumber === null ? undefined : s.pulls?.get(w.prNumber);
  return pull?.state === "open" ? pull : undefined;
};

const conflictText = (base = "HEAD"): string =>
  `This PR has merge conflicts with \`${base}\`. The Coordinator has fetched \`origin/${base}\` into your Worktree. ` +
  `Run \`git merge origin/${base}\` (merge, do not rebase: the push must stay a fast-forward), resolve the conflicts, ` +
  "run the tests and commit the merge.";

/** Issue numbers an Assessment's Coordination notes list under `blockedBy` or `bundleWith`. */
export function coordination(assessment: string | null, key: "blockedBy" | "bundleWith"): number[] {
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
