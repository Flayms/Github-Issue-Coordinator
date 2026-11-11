/**
 * The reconcile loop: every tick it syncs finished turns, polls each repository, derives actions,
 * schedules them across repositories and executes them. State lives in labels and the store, so a
 * tick can start from scratch after a restart (REQ-001-16).
 */
import { type Config, type Role, roleSettings } from "./config.ts";
import type { Clones } from "./git.ts";
import type { Actor, GitHubClient, Item } from "./github/client.ts";
import { Implementer, type ImplementerDeps } from "./implementer.ts";
import { agentNote } from "./note.ts";
import { bodyHash, Planner } from "./planner.ts";
import type { SessionRunner } from "./runner.ts";
import { type LiveSession, schedule, type Work } from "./scheduler.ts";
import { type Action, deriveActions, type IssueFeedback, issueState } from "./state.ts";
import type { IssueRecord, SessionRecord, Store } from "./store.ts";

/** How long to wait after a usage limit before trying again; the reset time's format is still unknown. */
export const USAGE_LIMIT_PAUSE_MIN = 30;

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
  >;
  runner: Pick<SessionRunner, "start" | "resume" | "close" | "sessionDir" | "liveSessionIds" | "answerDialogs">;
  clones: Pick<Clones, "mainClone">;
  worktrees: ImplementerDeps["worktrees"];
  now?: () => Date;
  log?: (message: string) => void;
}

interface RepoView {
  items: Item[];
  feedback: Map<number, IssueFeedback>;
  labelActors: Map<number, Actor | undefined>;
}

export class Coordinator {
  private readonly planner: Planner;
  private readonly implementer: Implementer;
  private readonly views = new Map<string, RepoView>();
  private readonly now: () => Date;
  private readonly log: (m: string) => void;

  constructor(private readonly d: CoordinatorDeps) {
    this.planner = new Planner(d);
    this.implementer = new Implementer(d);
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
          const actions = deriveActions({
            repo,
            ownerId: this.d.config.owner.id,
            items: view.items,
            sessions: this.d.store.sessions(repo),
            liveSessionIds: live,
            feedback: view.feedback,
            labelActors: view.labelActors,
            records: this.records(repo, view.items),
            now: this.now().toISOString(),
            worktrees: this.d.store.worktrees(repo),
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

  /** REQ-001-19: sync every turn that ended; REQ-001-17: a usage limit pauses new work. */
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
        if (!s.needsSync) continue;
        try {
          if (s.role === "planner") await this.planner.sync(s.id);
          if (s.role === "implementer") await this.implementer.sync(s.id);
        } catch (e) {
          this.log(`${repo}: sync of session ${s.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
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
      if (!PROPOSALS.includes(issueState(i.labels))) continue;
      const comments = (await this.d.gh.listComments(repo, i.number, { afterId: rec.lastHandledCommentId })).filter(
        (c) => c.author.id === this.d.config.owner.id,
      );
      const bodyChanged = rec.bodyHash !== null && rec.bodyHash !== bodyHash(i.body);
      if (comments.length || bodyChanged) feedback.set(i.number, { comments, bodyChanged });
    }
    const view = { items, feedback, labelActors };
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
        await this.fail(a.repo, a.issues, a.reason, a.session);
        return;
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
  private async fail(repo: string, issues: number[], reason: string, session?: SessionRecord) {
    const model = session ? roleSettings(this.d.config, repo, session.role).model : "coordinator";
    for (const n of issues) {
      for (const l of IN_FLIGHT_LABELS) await this.d.gh.removeLabel(repo, n, l);
      await this.d.gh.addLabels(repo, n, ["agent:failed"]);
      await this.d.gh.createComment(
        repo,
        n,
        `${agentNote(model, this.d.config.owner.login)}\n\nThe Coordinator gave up on this issue: ${reason}.`,
      );
    }
    if (session) {
      try {
        this.d.runner.close(session.id);
      } catch {
        this.d.store.patchSession(session.id, { state: "closed" });
      }
    }
    this.log(`${repo}: ${issues.map((n) => `#${n}`).join(", ")} failed: ${reason}`);
  }
}
