/**
 * The reconcile loop: every tick it syncs finished turns, polls each repository, derives actions,
 * schedules them across repositories and executes them. State lives in labels and the store, so a
 * tick can start from scratch after a restart (REQ-001-16).
 */
import { allPausedUntil } from "./accounts.ts";
import { type Config, type Role, roleSettings } from "./config.ts";
import { recordEvent, refs } from "./events.ts";
import type { Clones } from "./git.ts";
import type { Actor, Comment, GitHubClient, Item } from "./github/client.ts";
import { Implementer, type ImplementerDeps } from "./implementer.ts";
import { labelPr } from "./labels.ts";
import { agentNote, ROLE_NAMES } from "./note.ts";
import { bodyHash, Planner } from "./planner.ts";
import { Reviewer, type ReviewerDeps } from "./reviewer.ts";
import { type SessionRunner, SessionStartError } from "./runner.ts";
import { type LiveSession, type Queued, schedule, type WaitReason, type Work } from "./scheduler.ts";
import {
  type Action,
  coordination,
  deriveActions,
  type IssueFeedback,
  inScope,
  issueState,
  type PullState,
} from "./state.ts";
import type { CoordinatorEvent, EventKind, IssueRecord, SessionRecord, Store, WorktreeRecord } from "./store.ts";

/** How long to wait after a usage limit before trying again; the reset time's format is still unknown. */
export const USAGE_LIMIT_PAUSE_MIN = 30;
/** Failed syncs of a turn in a row before its issues are labelled `agent:failed` (REQ-001-27). */
export const MAX_SYNC_ATTEMPTS = 3;

const IN_FLIGHT_LABELS = ["agent:planning", "agent:in-progress", "agent:reviewing"];
/** REQ-001-57: Claude Code takes its prompt within seconds; a session that hasn't after this is stuck at a screen. */
export const START_TIMEOUT_MS = 5 * 60_000;
/** How much of a stuck session's screen its failure comment shows (REQ-001-57). */
const SCREEN_LINES = 25;

/** The last `n` lines of a screen, without trailing blank lines and trailing spaces. */
function lastLines(screen: string, n: number): string {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.slice(-n).join("\n");
}
const PROPOSALS = ["proposed", "needs-refinement", "wontfix-proposed"];

export interface CoordinatorDeps {
  config: Config;
  store: Store;
  gh: Pick<
    GitHubClient,
    | "listOpenItems"
    | "listOpenPulls"
    | "listComments"
    | "labelActor"
    | "itemHistory"
    | "addLabels"
    | "removeLabel"
    | "createComment"
    | "updateComment"
    | "createIssue"
    | "createPull"
    | "updatePull"
    | "setDraft"
    | "addAssignees"
    | "getPull"
    | "checks"
    | "createReview"
    | "listReviews"
  >;
  runner: Pick<
    SessionRunner,
    "start" | "resume" | "close" | "sessionDir" | "liveSessionIds" | "answerDialogs" | "screen" | "abandon"
  >;
  clones: Pick<Clones, "mainClone">;
  worktrees: ImplementerDeps["worktrees"] & ReviewerDeps["worktrees"];
  now?: () => Date;
  log?: (message: string) => void;
}

/** What the last tick saw and decided, for the dashboard (spec 003). Published in one piece at the end of a tick. */
export interface TickSnapshot {
  finishedAt: string;
  /** While every Account is paused by a usage limit, when the first is free again (REQ-001-17). */
  pausedUntil: string | null;
  repos: RepoSnapshot[];
  /** Open sessions; `live` says whether their tmux window is alive. */
  sessions: (SessionRecord & { live: boolean })[];
  /** Queued work in the scheduler's order, with why it waits (REQ-003-04). */
  queue: Queued[];
  /** The kept Events, newest first (REQ-003-16). */
  events: CoordinatorEvent[];
}

export interface RepoSnapshot {
  repo: string;
  /** Why polling the repository failed in this tick. */
  error: string | null;
  /** In-scope open issues (REQ-001-01), with the open issues they are blocked by (REQ-001-05). */
  issues: { number: number; title: string; labels: string[]; blockedBy: number[] }[];
  /** Open agent PRs. */
  pulls: {
    number: number;
    title: string;
    labels: string[];
    issues: number[];
    feedbackRounds: number;
    state: PullState | null;
  }[];
  /** Worktrees the store has for the repository (REQ-003-05, REQ-003-12). */
  worktrees: number;
}

type Job = () => Promise<WaitReason | undefined>;

interface RepoView {
  items: Item[];
  feedback: Map<number, IssueFeedback>;
  labelActors: Map<number, Actor | undefined>;
  prFeedback: Map<number, { comments: Comment[]; changesRequested: { id: number; body: string }[] }>;
}

export class Coordinator {
  private readonly planner: Planner;
  private readonly implementer: Implementer;
  private readonly reviewer: Reviewer;
  private readonly views = new Map<string, RepoView>();
  /** Failed sync attempts in a row per session; kept in memory, so a restart allows a few more (REQ-001-27). */
  private readonly syncFailures = new Map<number, number>();
  /** Orphaned agent PRs already reported as having no open issue to re-attach to (REQ-001-43). */
  private readonly reportedOrphans = new Set<string>();
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  private last: TickSnapshot | undefined;

  constructor(private readonly d: CoordinatorDeps) {
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.planner = new Planner({ ...d, log: this.log });
    this.implementer = new Implementer({ ...d, log: this.log });
    this.reviewer = new Reviewer({ ...d, log: this.log });
    d.store.adoptLegacyPause(this.accountNames()[0] as string);
  }

  private accountNames(): string[] {
    return this.d.config.accounts.map((a) => a.name);
  }

  /** REQ-001-17: while every Account is paused, when the first one is free again. */
  private allPausedUntil(): string | undefined {
    return allPausedUntil(this.d.config.accounts, (n) => this.d.store.pausedUntil(n), this.now());
  }

  /** The last tick's snapshot; undefined before the first tick ended (REQ-003-06). */
  snapshot(): TickSnapshot | undefined {
    return this.last;
  }

  async tick(): Promise<void> {
    const errors = new Map<string, string>();
    const pullStates = new Map<string, Map<number, PullState>>();
    let planned: Queued[] = [];
    try {
      await this.syncTurns();
      await this.failStalledStarts();
      const queue: Work[] = [];
      const jobs = new Map<string, Job>();
      const live = this.d.runner.liveSessionIds();
      for (const { name: repo } of this.d.config.repos) {
        try {
          const view = await this.poll(repo);
          const worktrees = this.d.store.worktrees(repo);
          const pulls = await this.pulls(repo, worktrees);
          pullStates.set(repo, pulls);
          const actions = deriveActions({
            repo,
            ownerId: this.d.config.owner.id,
            items: view.items,
            splitOffs: this.d.store.splitOffNumbers(repo),
            sessions: this.d.store.sessions(repo),
            pendingSync: this.d.store.sessionsToSync(repo).filter((s) => s.state === "closed"),
            liveSessionIds: live,
            feedback: view.feedback,
            labelActors: view.labelActors,
            records: this.records(repo, view.items),
            now: this.now().toISOString(),
            worktrees,
            pulls,
            prFeedback: view.prFeedback,
            openPulls: await this.d.gh.listOpenPulls(repo),
            maxFeedbackRounds: this.d.config.limits.maxFeedbackRounds,
            checksGraceSeconds: this.d.config.checksGraceSeconds,
          });
          for (const a of actions) await this.handle(a, view, queue, jobs);
          this.queueUsageLimited(repo, queue, jobs);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          errors.set(repo, error);
          this.log(`${repo}: ${error}`);
        }
      }
      planned = await this.run(queue, jobs);
    } catch (e) {
      this.log(`tick failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
    try {
      this.last = this.buildSnapshot(errors, pullStates, planned);
    } catch (e) {
      this.log(`dashboard snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Reads only memory and the store; changes nothing (REQ-003-07, REQ-003-08). */
  private buildSnapshot(
    errors: Map<string, string>,
    pullStates: Map<string, Map<number, PullState>>,
    queue: Queued[],
  ): TickSnapshot {
    const live = this.d.runner.liveSessionIds();
    const repos = this.d.config.repos.map(({ name: repo }): RepoSnapshot => {
      const items = this.views.get(repo)?.items ?? [];
      const open = new Set(items.map((i) => i.number));
      const splitOffs = this.d.store.splitOffNumbers(repo);
      const issues = items
        .filter((i) => inScope(i, this.d.config.owner.id, splitOffs))
        .map((i) => ({
          number: i.number,
          title: i.title,
          labels: [...i.labels],
          blockedBy: coordination(this.d.store.issue(repo, i.number).assessment, "blockedBy").filter((n) =>
            open.has(n),
          ),
        }));
      const worktrees = this.d.store.worktrees(repo);
      const pulls = worktrees.flatMap((w) => {
        const pr = w.prNumber === null ? undefined : items.find((i) => i.number === w.prNumber);
        if (!pr) return [];
        const state = pullStates.get(repo)?.get(pr.number);
        return [
          {
            number: pr.number,
            title: pr.title,
            labels: [...pr.labels],
            issues: [...w.issues],
            feedbackRounds: w.feedbackRounds,
            state: state ? { ...state } : null,
          },
        ];
      });
      return { repo, error: errors.get(repo) ?? null, issues, pulls, worktrees: worktrees.length };
    });
    const sessions = this.d.config.repos.flatMap(({ name }) =>
      this.d.store.sessions(name).map((s) => ({ ...s, live: live.has(s.id) })),
    );
    return {
      finishedAt: this.now().toISOString(),
      pausedUntil: this.allPausedUntil() ?? null,
      repos,
      sessions,
      queue,
      events: this.d.store.events(),
    };
  }

  /** REQ-001-19 / REQ-001-27: sync every turn that ended, retrying failures; REQ-001-17: a usage limit pauses its Account. */
  private async syncTurns(): Promise<void> {
    for (const { name: repo } of this.d.config.repos) {
      for (const s of this.d.store.sessions(repo)) {
        if (s.usageLimited) {
          // Sessions from before spec 004 ran on Claude's default folder, now the first Account's place.
          const account = s.account ?? (this.accountNames()[0] as string);
          const until = new Date(Date.parse(s.lastActivityAt) + USAGE_LIMIT_PAUSE_MIN * 60_000).toISOString();
          const current = this.d.store.pausedUntil(account);
          if (!current || current < until) {
            this.d.store.setPausedUntil(account, until);
            const all = this.allPausedUntil();
            this.log(
              `${repo}: usage limit reached in session ${s.id}; Account ${account} is paused until ${until}${all ? `; every Account is paused, new work waits until ${all}` : ""}`,
            );
          }
        }
      }
      for (const s of this.d.store.sessionsToSync(repo)) await this.sync(s);
    }
  }

  private async sync(s: SessionRecord): Promise<void> {
    try {
      if (s.role === "planner") await this.planner.sync(s.id);
      if (s.role === "implementer") await this.implementer.sync(s.id);
      if (s.role === "reviewer") await this.reviewer.sync(s.id);
      this.syncFailures.delete(s.id);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const attempts = (this.syncFailures.get(s.id) ?? 0) + 1;
      this.log(`${s.repo}: sync of session ${s.id} failed (attempt ${attempts}/${MAX_SYNC_ATTEMPTS}): ${error}`);
      if (attempts < MAX_SYNC_ATTEMPTS) {
        this.syncFailures.set(s.id, attempts);
        this.d.store.patchSession(s.id, { needsSync: true });
        return;
      }
      this.syncFailures.delete(s.id);
      this.d.store.patchSession(s.id, { needsSync: false });
      await this.fail(
        s.repo,
        s.issues,
        `syncing the ${s.role}'s Result to GitHub failed ${attempts} times; last error: ${error}`,
        s,
        this.prOf(s),
      );
    }
  }

  /** Lists open items; comments are only fetched when something in the repository changed. */
  private async poll(repo: string): Promise<RepoView> {
    const { changed, items } = await this.d.gh.listOpenItems(repo);
    const cached = this.views.get(repo);
    if (!changed && cached) return cached;
    const feedback = new Map<number, IssueFeedback>();
    const labelActors = new Map<number, Actor | undefined>();
    const splitOffs = this.d.store.splitOffNumbers(repo);
    for (const i of items) {
      if (!inScope(i, this.d.config.owner.id, splitOffs)) continue;
      const rec = this.d.store.issue(repo, i.number);
      // REQ-001-04: who added agent:approved, for approvals not on record yet.
      if (issueState(i.labels) === "approved" && !rec.approvedAt)
        labelActors.set(i.number, await this.d.gh.labelActor(repo, i.number, "agent:approved"));
      // Comments matter on proposals (feedback, /approve) and on any agent issue (/wake, REQ-001-24).
      if (issueState(i.labels) === "new") continue;
      const comments = (await this.d.gh.listComments(repo, i.number, { afterId: rec.lastHandledCommentId })).filter(
        (c) => c.author.id === this.d.config.owner.id,
      );
      const bodyChanged =
        PROPOSALS.includes(issueState(i.labels)) && rec.bodyHash !== null && rec.bodyHash !== bodyHash(i.body);
      if (comments.length || bodyChanged) feedback.set(i.number, { comments, bodyChanged });
    }
    // REQ-001-12 / REQ-001-24: the Owner's comments and changes-requested reviews on agent PRs.
    const prFeedback = new Map<number, { comments: Comment[]; changesRequested: { id: number; body: string }[] }>();
    for (const w of this.d.store.worktrees(repo)) {
      if (w.prNumber === null || !items.some((i) => i.number === w.prNumber)) continue;
      const rec = this.d.store.issue(repo, w.prNumber);
      const owner = (a: { author: { id: number } }) => a.author.id === this.d.config.owner.id;
      const comments = (await this.d.gh.listComments(repo, w.prNumber, { afterId: rec.lastHandledCommentId })).filter(
        owner,
      );
      const changesRequested = (await this.d.gh.listReviews(repo, w.prNumber))
        .filter((r) => owner(r) && r.state === "CHANGES_REQUESTED" && r.id > rec.lastHandledReviewId)
        .map((r) => ({ id: r.id, body: r.body }));
      if (comments.length || changesRequested.length) prFeedback.set(w.prNumber, { comments, changesRequested });
    }
    const view = { items, feedback, labelActors, prFeedback };
    this.views.set(repo, view);
    return view;
  }

  private async handle(a: Action, view: RepoView, queue: Work[], jobs: Map<string, Job>) {
    const now = this.now().toISOString();
    switch (a.type) {
      case "mark-closed":
        this.d.store.patchSession(a.session.id, { state: "closed" });
        return;
      case "fail":
        await this.fail(a.repo, a.issues, a.reason, a.session, a.pr);
        // REQ-001-13 / REQ-001-28: give up on a head's failing checks or conflicts once, not on every tick.
        if (a.headSha)
          for (const n of a.issues) {
            const rec = this.d.store.issue(a.repo, n);
            this.d.store.updateIssue(a.repo, n, {
              failedChecksSha: a.checksFailed ? a.headSha : rec.failedChecksSha,
              conflictSha: a.conflicted ? a.headSha : rec.conflictSha,
            });
          }
        return;
      case "feedback": {
        const own = this.d.store.latestSession(a.repo, a.issues[0] ?? 0, "implementer");
        const sessionId = own && own.state !== "closed" ? own.id : undefined;
        const key = `${a.repo} PR #${a.pr} feedback`;
        this.add(queue, jobs, { key, kind: "feedback", role: "implementer", queuedAt: now, sessionId }, async () => {
          // REQ-001-28 / REQ-001-37: before the round is recorded, so a failed fetch is retried on the next tick.
          if (a.conflicted) await this.implementer.fetchBase(a.repo, a.issues);
          for (const n of a.issues) {
            const rec = this.d.store.issue(a.repo, n);
            this.d.store.updateIssue(a.repo, n, {
              pendingFeedback: null,
              feedbackRounds: rec.feedbackRounds + (a.counted ? 1 : 0),
              failedChecksSha: a.checksFailed ? a.headSha : rec.failedChecksSha,
              conflictSha: a.conflicted ? a.headSha : rec.conflictSha,
            });
          }
          const pr = this.d.store.issue(a.repo, a.pr);
          this.d.store.updateIssue(a.repo, a.pr, {
            lastHandledCommentId: Math.max(pr.lastHandledCommentId, a.upToCommentId),
            lastHandledReviewId: Math.max(pr.lastHandledReviewId, a.upToReviewId),
          });
          view.prFeedback.delete(a.pr);
          const auto = a.causes.length ? { headSha: a.headSha, causes: a.causes } : undefined;
          const id = await this.implementer.feedbackRound(a.repo, a.pr, a.issues, a.text, auto);
          const rounds = this.d.store.issue(a.repo, a.issues[0] ?? 0).feedbackRounds;
          this.event(
            a.repo,
            "feedback-round",
            a.issues,
            a.pr,
            a.counted
              ? `Feedback round ${rounds}/${this.d.config.limits.maxFeedbackRounds} on PR #${a.pr}`
              : `Feedback round on PR #${a.pr} (not counted)`,
          );
          this.log(`${a.repo}: Feedback round on PR #${a.pr}${a.counted ? "" : " (from the Owner)"} (session ${id})`);
        });
        return;
      }
      case "wake": {
        const target =
          this.d.store.latestSession(a.repo, a.issue, "implementer") ??
          this.d.store.latestSession(a.repo, a.issue, "planner");
        const handled = () => {
          const rec = this.d.store.issue(a.repo, a.recordNumber);
          this.d.store.updateIssue(a.repo, a.recordNumber, {
            lastHandledCommentId: Math.max(rec.lastHandledCommentId, a.upToCommentId),
          });
          view.feedback.delete(a.recordNumber);
          view.prFeedback.delete(a.recordNumber);
        };
        if (!target?.claudeSessionId) {
          handled();
          this.log(`${a.repo}#${a.issue}: /wake, but there is no session to wake`);
          return;
        }
        const key = `${a.repo}#${a.issue} wake`;
        this.add(
          queue,
          jobs,
          { key, kind: "wake", role: target.role, queuedAt: now, sessionId: target.id },
          async () => {
            handled();
            this.d.runner.resume(
              target.id,
              "The Owner wants to chat with you in the Claude app. Reply with one short line that you are ready, then wait for their message.",
              roleSettings(this.d.config, a.repo, target.role),
              { keepResult: true },
            );
            this.log(`${a.repo}#${a.issue}: woke session ${target.id} for the Owner`);
          },
        );
        return;
      }
      case "approve":
        this.d.store.updateIssue(a.repo, a.issue, {
          approvedAt: a.at,
          approvalNotes: a.notes,
          lastHandledCommentId: Math.max(a.upToCommentId, this.d.store.issue(a.repo, a.issue).lastHandledCommentId),
        });
        await this.d.gh.removeLabel(a.repo, a.issue, "agent:proposed");
        // REQ-001-05: an issue that is still blocked goes straight to agent:blocked.
        if (a.blockers.length) {
          await this.d.gh.removeLabel(a.repo, a.issue, "agent:approved");
          await this.d.gh.addLabels(a.repo, a.issue, ["agent:blocked"]);
        } else await this.d.gh.addLabels(a.repo, a.issue, ["agent:approved"]);
        view.feedback.delete(a.issue);
        view.labelActors.delete(a.issue);
        this.event(
          a.repo,
          "approved",
          [a.issue],
          null,
          `#${a.issue} approved${a.blockers.length ? `, blocked by ${refs(a.blockers)}` : ""}`,
        );
        this.log(
          `${a.repo}#${a.issue}: approved by the Owner${a.blockers.length ? `, blocked by ${a.blockers.map((n) => `#${n}`).join(", ")}` : ""}`,
        );
        return;
      case "reject-approval":
        await this.d.gh.removeLabel(a.repo, a.issue, "agent:approved");
        view.labelActors.delete(a.issue);
        this.log(`${a.repo}#${a.issue}: removed agent:approved, which was not added by the Owner`);
        return;
      case "block":
        await this.d.gh.removeLabel(a.repo, a.issue, "agent:approved");
        await this.d.gh.addLabels(a.repo, a.issue, ["agent:blocked"]);
        this.event(a.repo, "blocked", [a.issue], null, `#${a.issue} blocked by ${refs(a.blockers)}`);
        this.log(`${a.repo}#${a.issue}: blocked by ${a.blockers.map((n) => `#${n}`).join(", ")}`);
        return;
      case "unblock":
        await this.d.gh.removeLabel(a.repo, a.issue, "agent:blocked");
        await this.d.gh.addLabels(a.repo, a.issue, ["agent:approved"]);
        this.event(a.repo, "unblocked", [a.issue], null, `#${a.issue} unblocked`);
        this.log(`${a.repo}#${a.issue}: unblocked`);
        return;
      case "implement": {
        const members = a.issues.map((n) => view.items.find((i) => i.number === n)).filter((i) => i !== undefined);
        const key = `${a.repo}#${a.issues[0]} implement`;
        this.add(queue, jobs, { key, kind: "implement", role: "implementer", queuedAt: a.approvedAt }, async () => {
          if (!this.d.worktrees.hasRoom()) {
            this.log(`${key}: waiting, maxWorktrees reached`);
            return { kind: "max-worktrees" };
          }
          try {
            const id = await this.implementer.start(a.repo, members);
            this.log(`${a.repo}: implementing ${a.issues.map((n) => `#${n}`).join(", ")} (session ${id})`);
          } catch (e) {
            if (e instanceof SessionStartError) throw e; // reported by run() (REQ-001-44)
            await this.fail(
              a.repo,
              a.issues,
              `could not start the Implementer: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        });
        return;
      }
      case "review": {
        const issues = a.issues.map((n) => view.items.find((i) => i.number === n)).filter((i) => i !== undefined);
        const key = `${a.repo} PR #${a.pr} review`;
        this.add(queue, jobs, { key, kind: "review", role: "reviewer", queuedAt: now }, async () => {
          const id = await this.reviewer.start(a.repo, a.pr, issues, a.headSha);
          this.log(`${a.repo}: reviewing PR #${a.pr} at ${a.headSha.slice(0, 7)} (session ${id})`);
        });
        return;
      }
      case "cleanup":
        if (await this.implementer.cleanup(a.repo, a.issues, a.worktreePath))
          this.log(`${a.repo}: PR #${a.prNumber} is closed; cleaned up ${a.issues.map((n) => `#${n}`).join(", ")}`);
        return;
      case "reattach":
        await this.reattach(a.repo, a.pr, a.branch, a.issues);
        return;
      case "orphan-closed": {
        const key = `${a.repo}#${a.pr}`;
        if (this.reportedOrphans.has(key)) return;
        this.reportedOrphans.add(key);
        this.log(
          `${a.repo}: PR #${a.pr} is an agent PR without a Worktree, but its issues (${a.issues.map((n) => `#${n}`).join(", ")}) are closed or out of scope; not re-attached`,
        );
        return;
      }
      case "resume-interrupted": {
        const s = a.session;
        this.add(
          queue,
          jobs,
          {
            key: `session ${s.id} resume`,
            kind: "resume-interrupted",
            role: s.role,
            queuedAt: s.lastActivityAt,
            sessionId: s.id,
          },
          async () => {
            this.d.store.recordResume(s.id);
            this.d.runner.resume(
              s.id,
              "The Coordinator was restarted while you were working. Continue where you left off.",
              roleSettings(this.d.config, s.repo, s.role),
            );
          },
        );
        return;
      }
      case "plan": {
        const assess = view.items.filter((i) => a.issues.includes(i.number));
        const oldest = assess.map((i) => i.createdAt).sort()[0] ?? now;
        this.add(queue, jobs, { key: `${a.repo} plan`, kind: "plan", role: "planner", queuedAt: oldest }, async () => {
          const dir = await this.d.clones.mainClone(a.repo);
          const splitOffs = this.d.store.splitOffNumbers(a.repo);
          const issues = view.items.filter((i) => inScope(i, this.d.config.owner.id, splitOffs));
          const pulls = view.items.filter((i) => i.isPullRequest);
          const id = await this.planner.startPass(a.repo, dir, assess, { issues, pulls });
          this.log(`${a.repo}: Planner pass over ${a.issues.map((n) => `#${n}`).join(", ")} (session ${id})`);
        });
        return;
      }
      case "revise": {
        const issue = view.items.find((i) => i.number === a.issue);
        if (!issue) return;
        const own = this.d.store.latestSession(a.repo, a.issue, "planner");
        const sessionId = own?.kind === "issue" && own.state !== "closed" ? own.id : undefined;
        this.add(
          queue,
          jobs,
          { key: `${a.repo}#${a.issue} revise`, kind: "revise", role: "planner", queuedAt: now, sessionId },
          async () => {
            const dir = await this.d.clones.mainClone(a.repo);
            const splitOffs = this.d.store.splitOffNumbers(a.repo);
            const issues = view.items.filter((i) => inScope(i, this.d.config.owner.id, splitOffs));
            const pulls = view.items.filter((i) => i.isPullRequest);
            const id = await this.planner.revise(
              a.repo,
              dir,
              issue,
              { comments: a.comments, bodyChanged: a.bodyChanged },
              { issues, pulls },
            );
            view.feedback.delete(a.issue);
            this.log(`${a.repo}#${a.issue}: revising the plan (session ${id})`);
          },
        );
        return;
      }
    }
  }

  /**
   * REQ-001-43: re-attach an orphaned agent PR, once GitHub reports the PR itself open on the same
   * branch: the open list may lag behind a PR just closed (REQ-001-14). Failures (maxWorktrees
   * reached, a folder in the way) are logged and retried on a later tick.
   */
  private async reattach(repo: string, pr: number, branch: string, issues: number[]) {
    try {
      const pull = await this.d.gh.getPull(repo, pr);
      if (pull.state !== "open" || pull.headRef !== branch) return;
      const path = await this.implementer.reattach(repo, pr, branch, issues);
      this.log(`${repo}: re-attached PR #${pr} to ${issues.map((n) => `#${n}`).join(", ")} in ${path}`);
    } catch (e) {
      this.log(`${repo}: could not re-attach PR #${pr}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * State, head, checks and mergeability of every agent PR on record. Read on every tick: a check
   * finishing does not change the issue list, so the ETag poll would not notice it (REQ-001-10,
   * REQ-001-28). Fetched per PR rather than taken from the list, which can be cached or lag behind a
   * PR just opened (REQ-001-14). A failed fetch is logged and the PR left out until the next tick.
   * Records when each head was first seen, for the checks grace period.
   */
  private async pulls(repo: string, worktrees: WorktreeRecord[]) {
    const out = new Map<number, PullState>();
    for (const w of worktrees) {
      if (w.prNumber === null) continue;
      let pull: Awaited<ReturnType<CoordinatorDeps["gh"]["getPull"]>>;
      try {
        pull = await this.d.gh.getPull(repo, w.prNumber);
      } catch (e) {
        this.log(`${repo}: could not read PR #${w.prNumber}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (pull.state !== "open") {
        out.set(w.prNumber, {
          headSha: pull.headSha,
          checks: "none",
          mergeable: pull.mergeable,
          headSeenAt: "",
          state: pull.state,
        });
        continue;
      }
      const checks = await this.d.gh.checks(repo, pull.headSha);
      let headSeenAt = w.headSeenAt;
      if (w.headSha !== pull.headSha || !headSeenAt) {
        headSeenAt = this.now().toISOString();
        for (const n of w.issues) this.d.store.updateIssue(repo, n, { headSha: pull.headSha, headSeenAt });
      }
      out.set(w.prNumber, {
        headSha: pull.headSha,
        checks: checks.state,
        failed: checks.failed,
        mergeable: pull.mergeable,
        headSeenAt,
        baseRef: pull.baseRef,
        state: pull.state,
      });
    }
    return out;
  }

  private records(repo: string, items: Item[]): Map<number, Pick<IssueRecord, "approvedAt" | "assessment">> {
    return new Map(
      items
        .filter((i) => !i.isPullRequest)
        .map((i) => {
          const r = this.d.store.issue(repo, i.number);
          return [i.number, { approvedAt: r.approvedAt, assessment: r.assessment }];
        }),
    );
  }

  /** REQ-001-17: continue sessions cut off by the usage limit, on an Account that isn't paused. */
  private queueUsageLimited(repo: string, queue: Work[], jobs: Map<string, Job>) {
    for (const s of this.d.store.sessions(repo).filter((x) => x.usageLimited && x.state !== "running")) {
      this.add(
        queue,
        jobs,
        {
          key: `session ${s.id} resume`,
          kind: "resume-interrupted",
          role: s.role,
          queuedAt: s.lastActivityAt,
          sessionId: s.id,
        },
        async () => {
          this.d.runner.resume(
            s.id,
            "Your last turn was cut off by the usage limit. Continue where you left off.",
            roleSettings(this.d.config, s.repo, s.role),
          );
        },
      );
    }
  }

  private add(
    queue: Work[],
    jobs: Map<string, Job>,
    w: Work,
    job: () => Promise<WaitReason | undefined> | Promise<void>,
  ) {
    if (jobs.has(w.key)) return;
    queue.push(w);
    jobs.set(w.key, async () => (await job()) ?? undefined);
  }

  /** Runs the scheduler's plan; returns the queue with the reasons work waits (REQ-003-04). */
  private async run(queue: Work[], jobs: Map<string, Job>): Promise<Queued[]> {
    const live = this.d.runner.liveSessionIds();
    const sessions: LiveSession[] = this.d.config.repos.flatMap(({ name }) =>
      this.d.store
        .sessions(name)
        .filter((s) => live.has(s.id) && s.state !== "closed")
        .map((s) => this.toLive(s)),
    );
    const plan = schedule({
      queue,
      sessions,
      limits: this.d.config.limits,
      now: this.now(),
      pausedUntil: this.allPausedUntil(),
    });
    for (const id of plan.close) {
      try {
        this.d.runner.close(id);
        this.log(`closed idle session ${id}`);
      } catch (e) {
        this.log(`could not close session ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const waits = new Map<string, WaitReason>();
    for (const w of plan.start) {
      try {
        const wait = await jobs.get(w.key)?.();
        if (wait) waits.set(w.key, wait);
      } catch (e) {
        this.log(`${w.key} failed: ${e instanceof Error ? e.message : String(e)}`);
        // REQ-001-44: a session that could not be launched fails its issues with the error, once.
        if (e instanceof SessionStartError) {
          await this.fail(e.session.repo, e.session.issues, e.message, e.session, this.prOf(e.session)).catch((f) =>
            this.log(`${w.key}: could not report the failure: ${f instanceof Error ? f.message : String(f)}`),
          );
        }
      }
    }
    return plan.queue.map((q) => {
      const wait = q.wait ?? waits.get(q.work.key);
      return wait ? { work: q.work, wait } : { work: q.work };
    });
  }

  /**
   * REQ-001-57: a session whose prompt Claude Code has not taken 5 minutes after launch is stuck at a screen nobody
   * answers (e.g. a new dialog); it would otherwise hold its Slot forever. Ends it and fails its issues with the screen.
   */
  private async failStalledStarts(): Promise<void> {
    const live = this.d.runner.liveSessionIds();
    for (const { name: repo } of this.d.config.repos) {
      for (const s of this.d.store.sessions(repo)) {
        const launched = Date.parse(s.lastActivityAt);
        if (s.state !== "running" || !s.coordinatorPromptPending || !live.has(s.id)) continue;
        if (this.now().getTime() - launched < START_TIMEOUT_MS) continue;
        const screen = lastLines(this.d.runner.screen(s.id), SCREEN_LINES);
        this.d.runner.abandon(s.id);
        await this.fail(
          repo,
          s.issues,
          `the session did not start within ${START_TIMEOUT_MS / 60_000} minutes, Claude Code stopped at a screen the Coordinator does not answer`,
          s,
          this.prOf(s),
          screen ? `Its screen:\n\n\`\`\`\n${screen}\n\`\`\`` : undefined,
        ).catch((e) =>
          this.log(`session ${s.id}: could not report the failed start: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    }
  }

  /** The agent PR of an Implementer's or Reviewer's issues, if one is open. */
  private prOf(s: SessionRecord): number | undefined {
    if (s.role === "planner") return undefined;
    return this.d.store.issue(s.repo, s.issues[0] ?? 0).prNumber ?? undefined;
  }

  private toLive(s: SessionRecord): LiveSession {
    const view = this.views.get(s.repo);
    const waitingOnOwner =
      s.role === "planner" &&
      s.issues.every((n) => {
        const i = view?.items.find((x) => x.number === n);
        return i !== undefined && PROPOSALS.includes(issueState(i.labels));
      });
    const pr = s.role === "implementer" ? this.d.store.issue(s.repo, s.issues[0] ?? 0).prNumber : null;
    return {
      id: s.id,
      role: s.role as Role,
      keepLonger: pr !== null && (view?.items.some((i) => i.number === pr) ?? false),
      state: s.state === "running" ? "running" : "idle",
      lastActivityAt: s.lastActivityAt,
      waitingOnOwner,
      ownerMessagedAt: s.ownerMessagedAt,
    };
  }

  /** Labels the issues agent:failed with the reason and closes the session (REQ-001-16, REQ-001-21). */
  private async fail(
    repo: string,
    issues: number[],
    reason: string,
    session?: SessionRecord,
    pr?: number,
    details?: string,
  ) {
    const note = agentNote({ owner: this.d.config.owner.login });
    const by = session ? ` (${ROLE_NAMES[session.role]} session)` : "";
    for (const n of issues) {
      for (const l of IN_FLIGHT_LABELS) await this.d.gh.removeLabel(repo, n, l);
      if (pr !== undefined)
        for (const l of ["agent:pr-open", "agent:reviewed"]) await this.d.gh.removeLabel(repo, n, l);
      await this.d.gh.addLabels(repo, n, ["agent:failed"]);
      this.d.store.updateIssue(repo, n, { pendingFeedback: null, reviewFindings: null });
      await this.d.gh.createComment(
        repo,
        n,
        `${note}\n\nThe Coordinator gave up on this issue${by}: ${reason}.${details ? `\n\n${details}` : ""}`,
      );
    }
    if (session) {
      try {
        this.d.runner.close(session.id);
      } catch {
        this.d.store.patchSession(session.id, { state: "closed" });
      }
    }
    if (pr !== undefined) {
      await labelPr(this.d.gh, repo, pr, "agent:failed");
      // REQ-001-31: a failed PR stays (or goes back to) draft; giving up must not fail on this.
      await this.d.gh
        .setDraft(repo, pr, true)
        .catch((e) => this.log(`${repo}: PR #${pr} not converted to draft: ${e}`));
    }
    this.event(repo, "failed", issues, pr ?? null, `${refs(issues)} failed: ${reason}`);
    this.log(`${repo}: ${issues.map((n) => `#${n}`).join(", ")} failed: ${reason}`);
  }

  /** REQ-003-15: only after the GitHub action succeeded; a store error is only logged. */
  private event(repo: string, kind: EventKind, issues: number[], pr: number | null, text: string) {
    recordEvent(this.d.store, this.log, { repo, kind, issues, pr, text });
  }
}
