/**
 * Planner pass (REQ-001-02), plan revision (REQ-001-03) and the sync of Planner turns to GitHub
 * (REQ-001-19): Assessment comments, verdict labels, and the Assessment kept in the store.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, roleSettings } from "./config.ts";
import type { GitHubClient, Item } from "./github/client.ts";
import { sessionNote } from "./note.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { type PlannerResult, validateResult } from "./results.ts";
import type { SessionRunner } from "./runner.ts";
import type { IssueFeedback } from "./state.ts";
import type { Store } from "./store.ts";

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

export function renderAssessment(a: Assessment, note: string): string {
  const parts = [note, `## Assessment: ${VERDICT_TITLES[a.verdict]}`, a.approach];
  if (a.questions.length) parts.push(`**Questions**\n\n${a.questions.map((q) => `- ${q}`).join("\n")}`);
  const notes = [
    ...a.bundleWith.map((n) => `- Do together with #${n}`),
    ...a.blockedBy.map((n) => `- Blocked by #${n}`),
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
  gh: Pick<GitHubClient, "addLabels" | "removeLabel" | "createComment" | "updateComment">;
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
   * REQ-001-03: hand the Owner's feedback to the issue's own Planner session, or to a fresh one
   * with the current Assessment if the issue so far was only part of a batch.
   */
  async revise(repo: string, repoDir: string, issue: Item, feedback: IssueFeedback): Promise<number> {
    const rec = this.d.store.issue(repo, issue.number);
    const lastComment = Math.max(rec.lastHandledCommentId, ...feedback.comments.map((c) => c.id));
    this.d.store.updateIssue(repo, issue.number, { lastHandledCommentId: lastComment, bodyHash: bodyHash(issue.body) });
    const model = roleSettings(this.d.config, repo, "planner");
    const feedbackText = renderFeedback(issue, feedback);

    const own = this.d.store.latestSession(repo, issue.number, "planner");
    if (own?.kind === "issue" && own.claudeSessionId) {
      this.d.runner.resume(own.id, feedbackText, model);
      return own.id;
    }
    const context = [
      renderContext({ assess: [issue], issues: [], pulls: [] })
        .split("## All open issues")[0]
        ?.trim(),
      "## Current Assessment",
      rec.assessment ?? "(none)",
      feedbackText,
    ].join("\n\n");
    return this.d.runner.start({
      repo,
      role: "planner",
      kind: "issue",
      issues: [issue.number],
      cwd: repoDir,
      prompt: renderPrompt(loadPrompt("planner", repoDir), { repo, context }),
      model,
    });
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
      const json = JSON.stringify(a);
      if (rec.assessment === json && rec.assessmentCommentId !== null) continue; // nothing changed
      const body = renderAssessment(a, note);
      let commentId = rec.assessmentCommentId;
      if (commentId === null) commentId = await this.d.gh.createComment(s.repo, a.issue, body);
      else await this.d.gh.updateComment(s.repo, commentId, body);
      this.d.store.updateIssue(s.repo, a.issue, { assessment: json, assessmentCommentId: commentId });

      const target = `agent:${a.verdict}`;
      for (const l of ["agent:planning", ...VERDICT_LABELS])
        if (l !== target) await this.d.gh.removeLabel(s.repo, a.issue, l);
      await this.d.gh.addLabels(s.repo, a.issue, [target]);
    }
    this.d.store.patchSession(sessionId, { needsSync: false });
    if (s.kind === "batch") this.d.runner.close(sessionId);
  }
}

function renderFeedback(issue: Item, f: IssueFeedback): string {
  const parts = ["## The Owner's feedback", "Revise your Assessment of this issue accordingly."];
  if (f.bodyChanged)
    parts.push(`The Owner edited the issue description. It now reads:\n\n${truncate(issue.body, BODY_LIMIT)}`);
  for (const c of f.comments) parts.push(`Comment:\n\n${c.body}`);
  return parts.join("\n\n");
}
