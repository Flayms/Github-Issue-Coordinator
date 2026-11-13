/**
 * Reviewer run (REQ-001-10): a fresh read-only session on a checkout of the PR head; its findings
 * are posted as one COMMENT review. The session is closed right after (REQ-001-23). Blocking
 * findings are kept for a Feedback round (REQ-001-11).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, roleSettings } from "./config.ts";
import type { GitHubClient, Item } from "./github/client.ts";
import { GitHubError } from "./github/http.ts";
import { sessionNote } from "./note.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { type ReviewerResult, validateResult } from "./results.ts";
import type { SessionRunner } from "./runner.ts";
import type { Store } from "./store.ts";
import type { Worktrees } from "./worktrees.ts";

type Finding = ReviewerResult["findings"][number];

export interface ReviewerDeps {
  config: Config;
  store: Store;
  gh: Pick<GitHubClient, "addLabels" | "removeLabel" | "createComment" | "createReview">;
  runner: Pick<SessionRunner, "start" | "close" | "sessionDir">;
  worktrees: Pick<Worktrees, "reviewCheckout" | "reviewPath" | "head" | "remove">;
}

export const renderFinding = (f: Finding): string =>
  `- **${f.severity}**${f.blocking ? " (blocking)" : ""} \`${f.path}:${f.line}\`: ${f.body}`;

export class Reviewer {
  constructor(private readonly d: ReviewerDeps) {}

  async start(repo: string, pr: number, issues: Item[], headSha: string): Promise<number> {
    const numbers = issues.map((i) => i.number);
    for (const n of numbers) {
      for (const l of ["agent:pr-open", "agent:reviewed"]) await this.d.gh.removeLabel(repo, n, l);
      await this.d.gh.addLabels(repo, n, ["agent:reviewing"]);
    }
    const path = await this.d.worktrees.reviewCheckout(repo, pr, headSha);
    const parts = ["## Issues", ...issues.map((i) => `### #${i.number} ${i.title}\n\n${i.body}`)];
    for (const n of numbers) {
      const a = this.d.store.issue(repo, n).assessment;
      if (a) parts.push(`## Approved Assessment of #${n}`, (JSON.parse(a) as { approach: string }).approach);
    }
    parts.push(
      "## Pull request",
      `PR #${pr}, head commit \`${headSha}\` (checked out here). Compare it with the default branch: \`git diff origin/HEAD...HEAD\`.`,
    );
    return this.d.runner.start({
      repo,
      role: "reviewer",
      kind: "issue",
      issues: numbers,
      cwd: path,
      prompt: renderPrompt(loadPrompt("reviewer", path), { repo, context: parts.join("\n\n") }),
      model: roleSettings(this.d.config, repo, "reviewer"),
    });
  }

  async sync(sessionId: number): Promise<void> {
    const s = this.d.store.session(sessionId);
    if (s?.role !== "reviewer") return;
    const pr = this.d.store.issue(s.repo, s.issues[0] ?? 0).prNumber;
    if (pr === null) return;
    const checkout = this.d.worktrees.reviewPath(s.repo, pr);
    const resultPath = join(this.d.runner.sessionDir(sessionId), "result.json");
    const check = validateResult(
      "reviewer",
      existsSync(resultPath) ? readFileSync(resultPath, "utf8") : undefined,
      s.issues,
    );
    const note = sessionNote(this.d.config, s);
    this.d.store.patchSession(sessionId, { needsSync: false });

    if (!check.ok) {
      if (s.resultFailures < 3) return;
      for (const n of s.issues) {
        await this.d.gh.removeLabel(s.repo, n, "agent:reviewing");
        await this.d.gh.addLabels(s.repo, n, ["agent:failed"]);
      }
      await this.d.gh.createComment(
        s.repo,
        pr,
        `${note}\n\nThe Reviewer could not produce a valid Result: ${check.problem}`,
      );
      this.finish(sessionId, checkout);
      return;
    }

    const result = check.value as ReviewerResult;
    const sha = this.d.worktrees.head(checkout);
    const body = `${note}\n\n## Review\n\n${result.summary}`;
    const comments = result.findings.map((f) => ({
      path: f.path,
      line: f.line,
      body: `**${f.severity}**${f.blocking ? " (blocking)" : ""}: ${f.body}`,
    }));
    try {
      await this.d.gh.createReview(s.repo, pr, { commitId: sha, body, comments });
    } catch (e) {
      // A finding outside the diff makes GitHub reject the whole review; post them in the body instead.
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
      const listed = `${body}\n\n### Findings\n\n${result.findings.map(renderFinding).join("\n")}`;
      await this.d.gh.createReview(s.repo, pr, { commitId: sha, body: listed, comments: [] });
    }

    const blocking = result.findings.filter((f) => f.blocking);
    for (const n of s.issues) {
      this.d.store.updateIssue(s.repo, n, {
        reviewedHeadSha: sha,
        pendingFeedback: blocking.length
          ? `Blocking Review findings:\n\n${blocking.map(renderFinding).join("\n")}`
          : null,
      });
      await this.d.gh.removeLabel(s.repo, n, "agent:reviewing");
      await this.d.gh.addLabels(s.repo, n, [blocking.length ? "agent:pr-open" : "agent:reviewed"]);
    }
    if (!blocking.length) await this.d.gh.addLabels(s.repo, pr, ["agent:reviewed"]);
    this.finish(sessionId, checkout);
  }

  /** REQ-001-23: the Reviewer session and its checkout go away once the Review is posted. */
  private finish(sessionId: number, checkout: string) {
    try {
      this.d.runner.close(sessionId);
    } catch {}
    this.d.worktrees.remove(checkout);
  }
}
