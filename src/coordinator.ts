/**
 * The reconcile loop: every tick it syncs finished turns, polls each repository, derives actions,
 * schedules them across repositories and executes them. State lives in labels and the store, so a
 * tick can start from scratch after a restart (REQ-001-16).
 */
import { type Config, type Role, roleSettings } from "./config.ts";
import type { Clones } from "./git.ts";
import type { Actor, Comment, GitHubClient, Item } from "./github/client.ts";
import { Implementer, type ImplementerDeps } from "./implementer.ts";
import { agentNote, ROLE_NAMES } from "./note.ts";
import { bodyHash, Planner } from "./planner.ts";
import { Reviewer, type ReviewerDeps } from "./reviewer.ts";
import type { SessionRunner } from "./runner.ts";
import { type LiveSession, schedule, type Work } from "./scheduler.ts";
import { type Action, deriveActions, type IssueFeedback, issueState, type PullState } from "./state.ts";
import type { IssueRecord, SessionRecord, Store, WorktreeRecord } from "./store.ts";

/** How long to wait after a usage limit before trying again; the reset time's format is still unknown. */
export const USAGE_LIMIT_PAUSE_MIN = 30;
/** Failed syncs of a turn in a row before its issues are labelled `agent:failed` (REQ-001-27). */
export const MAX_SYNC_ATTEMPTS = 3;

const IN_FLIGHT_LABELS = ["agent:planning", "agent:in-progress", "agent:reviewing"];
const PROPOSALS = ["proposed", "needs-refinement", "wontfix-proposed"];

export interface CoordinatorDeps {
  config: Config;
  store: Store;
  gh: Pick<
    GitHubClient,
    | "listOpenItems"
    | "listComments"
    | "labelActor"
    | "addLabels"
    | "removeLabel"
    | "createComment"
    | "updateComment"
    | "createPull"
    | "updatePull"
    | "setDraft"
    | "getPull"
    | "checks"
    | "createReview"
    | "listReviews"
  >;
  runner: Pick<SessionRunner, "start" | "resume" | "close" | "sessionDir" | "liveSessionIds" | "answerDialogs">;
  clones: Pick<Clones, "mainClone">;
  worktrees: ImplementerDeps["worktrees"] & ReviewerDeps["worktrees"];
  now?: () => Date;
  log?: (message: string) => void;
}

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
  private readonly now: () => Date;
  private readonly log: (m: string) => void;

  constructor(private readonly d: CoordinatorDeps) {
    this.planner = new Planner(d);
    this.implementer = new Implementer(d);
    this.reviewer = new Reviewer(d);
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
  }

  async tick(): Promise<void> {
    try {
      await this.syncTurns();
      const queue: Work[] = [];
      const jobs = new Map<string, () => Promise<void>>();
      const live = this.d.runner.liveSessionIds();
      for (const { name: repo } of this.d.config.repos) {
        try {
          const view = await this.poll(repo);
          const worktrees = this.d.store.worktrees(repo);
          const actions = deriveActions({
            repo,
            ownerId: this.d.config.owner.id,
            items: view.items,
            sessions: this.d.store.sessions(repo),
            pendingSync: this.d.store.sessionsToSync(repo).filter((s) => s.state === "closed"),
            liveSessionIds: live,
            feedback: view.feedback,
            labelActors: view.labelActors,
            records: this.records(repo, view.items),
            now: this.now().toISOString(),
            worktrees,
            pulls: await this.pulls(repo, view, worktrees),
            prFeedback: view.prFeedback,
            maxFeedbackRounds: this.d.config.limits.maxFeedbackRounds,
            checksGraceSeconds: this.d.config.checksGraceSeconds,
          });
          for (const a of actions) await this.handle(a, view, queue, jobs);
          this.queueUsageLimited(repo, queue, jobs);
        } catch (e) {
          this.log(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await this.run(queue, jobs);
    } catch (e) {
      this.log(`tick failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }

  /** REQ-001-19 / REQ-001-27: sync every turn that ended, retrying failures; REQ-001-17: a usage limit pauses new work. */
  private async syncTurns(): Promise<void> {
    for (const { name: repo } of this.d.config.repos) {
      for (const s of this.d.store.sessions(repo)) {
        if (s.usageLimited) {
          const until = new Date(Date.parse(s.lastActivityAt) + USAGE_LIMIT_PAUSE_MIN * 60_000).toISOString();
          const current = this.d.store.pausedUntil();
          if (!current || current < until) {
            this.d.store.setPausedUntil(until);
            this.log(`${repo}: usage limit reached in session ${s.id}; pausing until ${until}`);
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
      const pr = s.role === "planner" ? null : this.d.store.issue(s.repo, s.issues[0] ?? 0).prNumber;
      await this.fail(
        s.repo,
        s.issues,
        `syncing the ${s.role}'s Result to GitHub failed ${attempts} times; last error: ${error}`,
        s,
        pr ?? undefined,
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
    for (const i of items) {
      if (i.isPullRequest || i.author.id !== this.d.config.owner.id) continue;
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

  private async handle(a: Action, view: RepoView, queue: Work[], jobs: Map<string, () => Promise<void>>) {
    const now = this.now().toISOString();
    switch (a.type) {
      case "mark-closed":
        this.d.store.patchSession(a.session.id, { state: "closed" });
        return;
      case "fail":
        await this.fail(a.repo, a.issues, a.reason, a.session, a.pr);
        return;
      case "feedback": {
        const own = this.d.store.latestSession(a.repo, a.issues[0] ?? 0, "implementer");
        const sessionId = own && own.state !== "closed" ? own.id : undefined;
        const key = `${a.repo} PR #${a.pr} feedback`;
        this.add(queue, jobs, { key, kind: "feedback", role: "implementer", queuedAt: now, sessionId }, async () => {
          // REQ-001-28: before the round is recorded, so a failed fetch is retried on the next tick.
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
          const id = await this.implementer.feedbackRound(a.repo, a.pr, a.issues, a.text);
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
        await this.d.gh.addLabels(a.repo, a.issue, ["agent:approved"]);
        view.feedback.delete(a.issue);
        view.labelActors.delete(a.issue);
        this.log(`${a.repo}#${a.issue}: approved by the Owner`);
        return;
      case "reject-approval":
        await this.d.gh.removeLabel(a.repo, a.issue, "agent:approved");
        view.labelActors.delete(a.issue);
        this.log(`${a.repo}#${a.issue}: removed agent:approved, which was not added by the Owner`);
        return;
      case "block":
        await this.d.gh.removeLabel(a.repo, a.issue, "agent:approved");
        await this.d.gh.addLabels(a.repo, a.issue, ["agent:blocked"]);
        this.log(`${a.repo}#${a.issue}: blocked by ${a.blockers.map((n) => `#${n}`).join(", ")}`);
        return;
      case "unblock":
        await this.d.gh.removeLabel(a.repo, a.issue, "agent:blocked");
        await this.d.gh.addLabels(a.repo, a.issue, ["agent:approved"]);
        this.log(`${a.repo}#${a.issue}: unblocked`);
        return;
      case "implement": {
        const members = a.issues.map((n) => view.items.find((i) => i.number === n)).filter((i) => i !== undefined);
        const key = `${a.repo}#${a.issues[0]} implement`;
        this.add(queue, jobs, { key, kind: "implement", role: "implementer", queuedAt: a.approvedAt }, async () => {
          if (!this.d.worktrees.hasRoom()) {
            this.log(`${key}: waiting, maxWorktrees reached`);
            return;
          }
          try {
            const id = await this.implementer.start(a.repo, members);
            this.log(`${a.repo}: implementing ${a.issues.map((n) => `#${n}`).join(", ")} (session ${id})`);
          } catch (e) {
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
          const issues = view.items.filter((i) => !i.isPullRequest && i.author.id === this.d.config.owner.id);
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
            const id = await this.planner.revise(a.repo, dir, issue, {
              comments: a.comments,
              bodyChanged: a.bodyChanged,
            });
            view.feedback.delete(a.issue);
            this.log(`${a.repo}#${a.issue}: revising the plan (session ${id})`);
          },
        );
        return;
      }
    }
  }

  /**
   * Head, checks and mergeability of open agent PRs. Read on every tick: a check finishing does not
   * change the issue list, so the ETag poll would not notice it (REQ-001-10, REQ-001-28). Records when
   * each head was first seen, for the checks grace period.
   */
  private async pulls(repo: string, view: RepoView, worktrees: WorktreeRecord[]) {
    const out = new Map<number, PullState>();
    for (const w of worktrees) {
      if (w.prNumber === null || !view.items.some((i) => i.number === w.prNumber)) continue;
      const pull = await this.d.gh.getPull(repo, w.prNumber);
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

  /** REQ-001-17: continue sessions cut off by the usage limit once the pause is over. */
  private queueUsageLimited(repo: string, queue: Work[], jobs: Map<string, () => Promise<void>>) {
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
            "The usage limit has reset. Continue where you left off.",
            roleSettings(this.d.config, s.repo, s.role),
          );
        },
      );
    }
  }

  private add(queue: Work[], jobs: Map<string, () => Promise<void>>, w: Work, job: () => Promise<void>) {
    if (jobs.has(w.key)) return;
    queue.push(w);
    jobs.set(w.key, job);
  }

  private async run(queue: Work[], jobs: Map<string, () => Promise<void>>) {
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
      pausedUntil: this.d.store.pausedUntil(),
    });
    for (const id of plan.close) {
      try {
        this.d.runner.close(id);
        this.log(`closed idle session ${id}`);
      } catch (e) {
        this.log(`could not close session ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const w of plan.start) {
      try {
        await jobs.get(w.key)?.();
      } catch (e) {
        this.log(`${w.key} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
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
  private async fail(repo: string, issues: number[], reason: string, session?: SessionRecord, pr?: number) {
    const note = agentNote({ owner: this.d.config.owner.login });
    const by = session ? ` (${ROLE_NAMES[session.role]} session)` : "";
    for (const n of issues) {
      for (const l of IN_FLIGHT_LABELS) await this.d.gh.removeLabel(repo, n, l);
      if (pr !== undefined)
        for (const l of ["agent:pr-open", "agent:reviewed"]) await this.d.gh.removeLabel(repo, n, l);
      await this.d.gh.addLabels(repo, n, ["agent:failed"]);
      this.d.store.updateIssue(repo, n, { pendingFeedback: null });
      await this.d.gh.createComment(repo, n, `${note}\n\nThe Coordinator gave up on this issue${by}: ${reason}.`);
    }
    if (session) {
      try {
        this.d.runner.close(session.id);
      } catch {
        this.d.store.patchSession(session.id, { state: "closed" });
      }
    }
    if (pr !== undefined) {
      await this.d.gh.addLabels(repo, pr, ["agent:failed"]);
      // REQ-001-31: a failed PR stays (or goes back to) draft; giving up must not fail on this.
      await this.d.gh
        .setDraft(repo, pr, true)
        .catch((e) => this.log(`${repo}: PR #${pr} not converted to draft: ${e}`));
    }
    this.log(`${repo}: ${issues.map((n) => `#${n}`).join(", ")} failed: ${reason}`);
  }
}
