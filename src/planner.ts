/**
 * Planner pass (REQ-001-02), plan revision (REQ-001-03, REQ-001-41) and the sync of Planner turns to GitHub
 * (REQ-001-19): Assessment comments, Replies (REQ-001-40), verdict labels, and the Assessment kept in the store.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, roleSettings } from "./config.ts";
import type { Comment, GitHubClient, Item } from "./github/client.ts";
import { GitHubError } from "./github/http.ts";
import { sessionNote } from "./note.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { type PlannerResult, validateResult } from "./results.ts";
import type { SessionRunner } from "./runner.ts";
import type { IssueFeedback } from "./state.ts";
import type { SplitOff, Store } from "./store.ts";

export { isCommand } from "./state.ts";

export type Assessment = PlannerResult[number];

const VERDICT_LABELS = ["agent:proposed", "agent:needs-refinement", "agent:wontfix-proposed"] as const;
const VERDICT_TITLES: Record<Assessment["verdict"], string> = {
  proposed: "proposed",
  "needs-refinement": "needs refinement",
  "wontfix-proposed": "won't fix (proposed)",
};
const BODY_LIMIT = 4_000;

export const bodyHash = (body: string): string => createHash("sha256").update(body).digest("hex");

export function renderAssessment(a: Assessment, note: string, splitOffs: SplitOff[] = []): string {
  const parts = [note, `## Assessment: ${VERDICT_TITLES[a.verdict]}`, a.approach];
  if (a.questions.length) parts.push(`**Questions**\n\n${a.questions.map((q) => `- ${q}`).join("\n")}`);
  const notes = [
    ...a.bundleWith.map((n) => `- Do together with #${n}`),
    ...a.blockedBy.map((n) => `- Blocked by #${n}`),
    ...splitOffs.map((s) => `- Split off #${s.number}`),
  ];
  if (notes.length) parts.push(`**Coordination**\n\n${notes.join("\n")}`);
  parts.push(
    "<sub>Reply to revise this plan. Approve it with the `agent:approved` label or a `/approve [notes]` comment.</sub>",
  );
  return parts.join("\n\n");
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s);
const labelsOf = (i: Item) => (i.labels.length ? ` [${i.labels.join(", ")}]` : "");

export function renderContext(c: { assess: Item[]; issues: Item[]; pulls: Item[] }): string {
  const assess = c.assess.map((i) => `### #${i.number} ${i.title}${labelsOf(i)}\n\n${truncate(i.body, BODY_LIMIT)}`);
  const list = (items: Item[]) =>
    items.length ? items.map((i) => `- #${i.number} ${i.title}${labelsOf(i)}`).join("\n") : "(none)";
  return [
    "## Issues to assess",
    assess.join("\n\n"),
    "## All open issues",
    list(c.issues),
    "## Open pull requests",
    list(c.pulls),
  ].join("\n\n");
}

export interface PlannerDeps {
  config: Config;
  store: Store;
  gh: Pick<GitHubClient, "addLabels" | "removeLabel" | "createComment" | "updateComment" | "createIssue">;
  runner: Pick<SessionRunner, "start" | "resume" | "close" | "sessionDir">;
}

export class Planner {
  constructor(private readonly d: PlannerDeps) {}

  /** REQ-001-02: label the issues `agent:planning` and run one batch session over them. */
  async startPass(
    repo: string,
    repoDir: string,
    assess: Item[],
    all: { issues: Item[]; pulls: Item[] },
  ): Promise<number> {
    for (const i of assess) {
      await this.d.gh.addLabels(repo, i.number, ["agent:planning"]);
      this.d.store.updateIssue(repo, i.number, { bodyHash: bodyHash(i.body) });
    }
    const context = renderContext({ assess, ...all });
    return this.d.runner.start({
      repo,
      role: "planner",
      kind: "batch",
      issues: assess.map((i) => i.number),
      cwd: repoDir,
      prompt: renderPrompt(loadPrompt("planner", repoDir), { repo, context }),
      model: roleSettings(this.d.config, repo, "planner"),
    });
  }

  /**
   * REQ-001-03: hand the Owner's comments to the issue's own Planner session, or to a fresh one with the
   * current Assessment if the issue so far was only part of a batch.
   * REQ-001-41: an edited description is planned from scratch, in a fresh session without the old Assessment.
   * REQ-001-40: the comments are kept as owing a Reply until the turn is synced.
   */
  async revise(
    repo: string,
    repoDir: string,
    issue: Item,
    feedback: IssueFeedback,
    all: { issues: Item[]; pulls: Item[] },
  ): Promise<number> {
    const rec = this.d.store.issue(repo, issue.number);
    const commentIds = feedback.comments.map((c) => c.id);
    // REQ-001-44: the feedback counts as handled only once a session has it, so a failed start keeps it for a retry.
    const handled = (replyTo: number[]) =>
      this.d.store.updateIssue(repo, issue.number, {
        lastHandledCommentId: Math.max(rec.lastHandledCommentId, ...commentIds),
        bodyHash: bodyHash(issue.body),
        replyTo,
      });
    const model = roleSettings(this.d.config, repo, "planner");
    const own = this.d.store.latestSession(repo, issue.number, "planner");
    const start = (context: string) =>
      this.d.runner.start({
        repo,
        role: "planner",
        kind: "issue",
        issues: [issue.number],
        title: issue.title,
        cwd: repoDir,
        prompt: renderPrompt(loadPrompt("planner", repoDir), { repo, context }),
        model,
      });

    if (feedback.bodyChanged) {
      if (own?.kind === "issue" && own.state !== "closed") this.d.runner.close(own.id);
      const context = renderContext({ assess: [issue], ...all });
      const id = start(feedback.comments.length ? `${context}\n\n${renderFeedback(feedback.comments, true)}` : context);
      handled(commentIds);
      return id;
    }

    const feedbackText = renderFeedback(feedback.comments, false);
    if (own?.kind === "issue" && own.claudeSessionId) {
      this.d.runner.resume(own.id, feedbackText, model);
      handled([...rec.replyTo, ...commentIds]);
      return own.id;
    }
    const id = start(
      [
        renderContext({ assess: [issue], issues: [], pulls: [] })
          .split("## All open issues")[0]
          ?.trim(),
        "## Current Assessment",
        rec.assessment ?? "(none)",
        feedbackText,
      ].join("\n\n"),
    );
    handled([...rec.replyTo, ...commentIds]);
    return id;
  }

  /** REQ-001-02/03/19/21: after any turn, bring GitHub in line with the session's Result. */
  async sync(sessionId: number): Promise<void> {
    const s = this.d.store.session(sessionId);
    if (s?.role !== "planner") return;
    const path = join(this.d.runner.sessionDir(sessionId), "result.json");
    const check = validateResult("planner", existsSync(path) ? readFileSync(path, "utf8") : undefined, s.issues);
    const note = sessionNote(this.d.config, s);

    if (!check.ok) {
      if (s.resultFailures >= 3) {
        for (const n of s.issues) {
          await this.d.gh.removeLabel(s.repo, n, "agent:planning");
          await this.d.gh.addLabels(s.repo, n, ["agent:failed"]);
          await this.d.gh.createComment(
            s.repo,
            n,
            `${note}\n\nThe Planner could not produce a valid Assessment: ${check.problem}`,
          );
        }
        this.d.runner.close(sessionId);
      }
      this.d.store.patchSession(sessionId, { needsSync: false });
      return;
    }

    for (const a of check.value as PlannerResult) {
      const rec = this.d.store.issue(s.repo, a.issue);
      const { reply, ...assessment } = a;
      const json = JSON.stringify(assessment);
      let commentId = rec.assessmentCommentId;
      if (rec.assessment !== json || commentId === null) {
        const splitOffs = await this.createSplitOffs(s.repo, a, note);
        const body = renderAssessment(a, note, splitOffs);
        commentId = await this.postAssessment(s.repo, a.issue, commentId, body);
        this.d.store.updateIssue(s.repo, a.issue, { assessment: json, assessmentCommentId: commentId });

        const target = `agent:${a.verdict}`;
        for (const l of ["agent:planning", ...VERDICT_LABELS])
          if (l !== target) await this.d.gh.removeLabel(s.repo, a.issue, l);
        await this.d.gh.addLabels(s.repo, a.issue, [target]);
      }
      // REQ-001-40: only a turn the Owner's comments started owes a Reply; cleared right after posting it.
      if (rec.replyTo.length) {
        await this.d.gh.createComment(
          s.repo,
          a.issue,
          renderReply(s.repo, a.issue, rec.replyTo, commentId, reply, note),
        );
        this.d.store.updateIssue(s.repo, a.issue, { replyTo: [] });
      }
    }
    this.d.store.patchSession(sessionId, { needsSync: false });
    if (s.kind === "batch") this.d.runner.close(sessionId);
  }

  /**
   * REQ-001-34: creates the entry's Split-off issues that weren't created for this issue before (same title,
   * ignoring case and surrounding spaces), recording each one right away. Returns all of the issue's Split-off issues.
   */
  private async createSplitOffs(repo: string, a: Assessment, note: string): Promise<SplitOff[]> {
    const key = (title: string) => title.trim().toLowerCase();
    const known = new Set(this.d.store.splitOffs(repo, a.issue).map((s) => key(s.title)));
    for (const p of a.splitOff) {
      if (known.has(key(p.title))) continue;
      known.add(key(p.title));
      const body = `${note}\n\nSplit off from #${a.issue}.\n\n${p.body}`;
      const number = await this.d.gh.createIssue(repo, { title: p.title, body });
      this.d.store.recordSplitOff(repo, a.issue, { number, title: p.title });
    }
    return this.d.store.splitOffs(repo, a.issue);
  }

  /** Edits the Assessment comment in place (REQ-001-03), or posts it anew if there is none or the Owner deleted it (REQ-001-32). */
  private async postAssessment(repo: string, issue: number, commentId: number | null, body: string): Promise<number> {
    if (commentId !== null) {
      try {
        await this.d.gh.updateComment(repo, commentId, body);
        return commentId;
      } catch (e) {
        if (!(e instanceof GitHubError && e.status === 404)) throw e;
      }
    }
    return this.d.gh.createComment(repo, issue, body);
  }
}

function renderFeedback(comments: Comment[], fresh: boolean): string {
  const parts = [
    "## The Owner's feedback",
    fresh
      ? "The Owner also commented on this issue. Take it into account."
      : "Revise your Assessment of this issue accordingly.",
    ...comments.map((c) => `Comment:\n\n${c.body}`),
    "In your Result, also write `reply` for this issue: a few lines for the Owner on what changed in the Assessment and why, or why nothing changed.",
  ];
  return parts.join("\n\n");
}

const commentUrl = (repo: string, issue: number, id: number) =>
  `https://github.com/${repo}/issues/${issue}#issuecomment-${id}`;

/** REQ-001-40: the Reply to the Owner's comments, linking them and the Assessment. */
export function renderReply(
  repo: string,
  issue: number,
  commentIds: number[],
  assessmentCommentId: number,
  reply: string | undefined,
  note: string,
): string {
  const url = (id: number) => commentUrl(repo, issue, id);
  const re =
    commentIds.length === 1
      ? `[your comment](${url(commentIds[0] as number)})`
      : `your comments ${commentIds.map((id, i) => `[${i + 1}](${url(id)})`).join(", ")}`;
  return [
    note,
    `Re: ${re}`,
    reply?.trim() || "Took your feedback into account in the Assessment.",
    `<sub>See the [Assessment](${url(assessmentCommentId)}).</sub>`,
  ].join("\n\n");
}
