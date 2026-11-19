/**
 * Reviewer run (REQ-001-10): a fresh read-only session on a checkout of the PR head; its findings
 * are posted as one COMMENT review. The session is closed right after (REQ-001-23). Every finding
 * is kept for a Feedback round (REQ-001-11). A head without findings leaves draft once its checks passed
 * (REQ-001-31, REQ-001-64), and the Owner is assigned to the PR then (REQ-001-52), unless the auto-merge mode lets
 * the Coordinator merge it itself (REQ-001-65, REQ-001-66). Every Review names a Risk tier (REQ-002-16).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AutoMergeMode, type Config, roleSettings } from "./config.ts";
import { defaultLog, recordEvent, refs } from "./events.ts";
import type { GitHubClient, Item } from "./github/client.ts";
import { GitHubError } from "./github/http.ts";
import { setPrPhase } from "./labels.ts";
import { agentNote, sessionNote } from "./note.ts";
import { rolePrompt } from "./prompts.ts";
import { type ReviewerResult, type RiskTier, validateResult } from "./results.ts";
import type { SessionRunner } from "./runner.ts";
import type { Store } from "./store.ts";
import type { Worktrees } from "./worktrees.ts";

export type Finding = ReviewerResult["findings"][number];

export interface ReviewerDeps {
  config: Config;
  store: Store;
  gh: Pick<
    GitHubClient,
    "addLabels" | "removeLabel" | "createComment" | "createReview" | "setDraft" | "addAssignees" | "mergePull"
  >;
  runner: Pick<SessionRunner, "start" | "close" | "sessionDir">;
  worktrees: Pick<Worktrees, "reviewCheckout" | "reviewPath" | "head" | "remove" | "changedFiles">;
  log?: (message: string) => void;
}

/** REQ-001-65: CI workflows run with the repository's secrets, so a change to them is never auto-merged on a tier. */
const WORKFLOWS = ".github/workflows/";

/**
 * REQ-002-16: the tier the Coordinator acts on, and its line in the Review. A head that changes a workflow, or whose
 * changed files can't be listed, is `high` whatever the Reviewer said (REQ-001-65).
 */
function riskOf(result: ReviewerResult, files: string[] | undefined): { tier: RiskTier; line: string } {
  const said = `${result.risk}: ${result.riskReason}`;
  const why = files === undefined ? "its changed files could not be listed" : `it changes \`${WORKFLOWS}\``;
  if (result.risk === "high" || (files !== undefined && !files.some((f) => f.startsWith(WORKFLOWS))))
    return { tier: result.risk, line: `**Risk tier:** ${said}` };
  return { tier: "high", line: `**Risk tier:** high (the Reviewer said ${said}): ${why}, so it is never auto-merged.` };
}

export const renderFinding = (f: Finding): string => `**${f.severity}** \`${f.path}:${f.line}\`: ${f.body}`;

/** The Feedback round's text: every finding, numbered so the Implementer can answer each one (REQ-001-35). */
const feedbackText = (findings: Finding[]): string =>
  [
    "Review findings. Answer each one by its number in `responses` of your Result: `fixed`, or `declined` with the reason.",
    ...findings.map((f, i) => `${i + 1}. ${renderFinding(f)}`),
  ].join("\n\n");

export class Reviewer {
  constructor(private readonly d: ReviewerDeps) {}

  async start(repo: string, pr: number, issues: Item[], headSha: string): Promise<number> {
    const numbers = issues.map((i) => i.number);
    await setPrPhase(this.d.gh, repo, { issues: numbers, pr }, "agent:reviewing", ["agent:pr-open", "agent:reviewed"]);
    const path = await this.d.worktrees.reviewCheckout(repo, pr, headSha);
    const parts = ["## Issues", ...issues.map((i) => `### #${i.number} ${i.title}\n\n${i.body}`)];
    for (const n of numbers) {
      const a = this.d.store.issue(repo, n).assessment;
      if (a) parts.push(`## Approved Assessment of #${n}`, (JSON.parse(a) as { approach: string }).approach);
    }
    // REQ-001-36: a re-review sees the earlier findings and the Implementer's answers.
    const history = this.d.store.issue(repo, numbers[0] ?? 0).reviewHistory;
    if (history)
      parts.push(
        "## Earlier Reviews and the Implementer's answers",
        history,
        "Raise a declined finding again only if you say why its reason is wrong.",
      );
    parts.push(
      "## Pull request",
      `PR #${pr}, head commit \`${headSha}\` (checked out here). Compare it with the default branch: \`git diff origin/HEAD...HEAD\`.`,
    );
    return this.d.runner.start({
      repo,
      role: "reviewer",
      kind: "issue",
      issues: numbers,
      title: issues[0]?.title,
      cwd: path,
      prompt: rolePrompt(this.d.config, "reviewer", path, { repo, context: parts.join("\n\n") }),
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
      await setPrPhase(this.d.gh, s.repo, { issues: s.issues, pr }, "agent:failed", ["agent:reviewing"]);
      await this.d.gh.createComment(
        s.repo,
        pr,
        `${note}\n\nThe Reviewer could not produce a valid Result: ${check.problem}`,
      );
      this.event({
        repo: s.repo,
        kind: "failed",
        issues: s.issues,
        pr,
        text: `${refs(s.issues)} failed: the Reviewer could not produce a valid Result`,
      });
      this.finish(sessionId, checkout);
      return;
    }

    const result = check.value as ReviewerResult;
    const sha = this.d.worktrees.head(checkout);
    let files: string[] | undefined;
    try {
      files = this.d.worktrees.changedFiles(checkout);
    } catch {}
    const risk = riskOf(result, files);
    const body = `${note}\n\n## Review\n\n${result.summary}\n\n${risk.line}`;
    const comments = result.findings.map((f) => ({
      path: f.path,
      line: f.line,
      body: `**${f.severity}**: ${f.body}`,
    }));
    try {
      await this.d.gh.createReview(s.repo, pr, { commitId: sha, body, comments });
    } catch (e) {
      // A finding outside the diff makes GitHub reject the whole review; post them in the body instead.
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
      const listed = `${body}\n\n### Findings\n\n${result.findings.map((f) => `- ${renderFinding(f)}`).join("\n")}`;
      await this.d.gh.createReview(s.repo, pr, { commitId: sha, body: listed, comments: [] });
    }

    // REQ-001-11: every posted finding is one to fix, so any finding starts a Feedback round.
    // REQ-001-39: the next step is the Implementer's, so the issue goes straight to agent:in-progress.
    const { findings } = result;
    for (const n of s.issues) {
      this.d.store.updateIssue(s.repo, n, {
        reviewedHeadSha: sha,
        reviewRisk: risk.tier,
        pendingFeedback: findings.length ? feedbackText(findings) : null,
        reviewFindings: findings.length ? JSON.stringify(findings) : null,
      });
    }
    const label = findings.length ? "agent:in-progress" : "agent:reviewed";
    // REQ-001-64: the PR leaves draft in a later Tick, once the head's checks passed (markReady).
    await setPrPhase(this.d.gh, s.repo, { issues: s.issues, pr }, label, ["agent:reviewing"]);
    this.event({
      repo: s.repo,
      kind: findings.length ? "review-findings" : "review-passed",
      issues: s.issues,
      pr,
      text: findings.length
        ? `Review of PR #${pr}: ${findings.length === 1 ? "1 finding" : `${findings.length} findings`}`
        : `Review of PR #${pr}: no findings`,
    });
    this.finish(sessionId, checkout);
  }

  /** REQ-003-15: after the Review is on GitHub; a store error is only logged. */
  private event(e: Parameters<typeof recordEvent>[2]) {
    recordEvent(this.d.store, this.d.log ?? defaultLog, e);
  }

  /** REQ-001-31: a reviewed head without findings whose checks passed leaves draft; REQ-001-52: the Owner is assigned. */
  async markReady(repo: string, pr: number): Promise<void> {
    await this.d.gh.setDraft(repo, pr, false);
    await this.assignOwner(repo, pr);
  }

  /**
   * REQ-001-66: merges a PR whose head passed the gates to leave draft (REQ-001-31) and that the auto-merge mode allows,
   * squashed and pinned to that head. GitHub can't merge a draft, so it leaves draft first. A refused merge (branch
   * protection, a required review, a newer head) leaves the PR ready for the Owner, assigned, with the reason quoted.
   * Returns whether it merged.
   */
  async autoMerge(
    repo: string,
    pr: number,
    headSha: string,
    why: { mode: Exclude<AutoMergeMode, "off">; risk: RiskTier | null },
  ): Promise<boolean> {
    await this.d.gh.setDraft(repo, pr, false);
    const note = agentNote({ owner: this.d.config.owner.login });
    const reason = `auto-merge mode \`${why.mode}\`, Risk tier **${why.risk ?? "unknown"}**`;
    try {
      await this.d.gh.mergePull(repo, pr, { sha: headSha, method: "squash" });
    } catch (e) {
      await this.assignOwner(repo, pr);
      const message = e instanceof Error ? e.message : String(e);
      await this.d.gh.createComment(
        repo,
        pr,
        `${note}\n\nThe Coordinator tried to merge \`${headSha.slice(0, 7)}\` (${reason}), but GitHub refused:\n\n> ${message}\n\nIt is ready for review: please merge it yourself.`,
      );
      return false;
    }
    await this.d.gh.createComment(
      repo,
      pr,
      `${note}\n\nMerged \`${headSha.slice(0, 7)}\` (squash) without waiting for the Owner: ${reason}. Its Review had no findings and its checks passed.`,
    );
    return true;
  }

  /** REQ-001-52: best effort; a refused assignment is logged and never fails the Review. */
  private async assignOwner(repo: string, pr: number) {
    try {
      await this.d.gh.addAssignees(repo, pr, [this.d.config.owner.login]);
    } catch (e) {
      const log = this.d.log ?? ((m: string) => console.log(`${new Date().toISOString()} ${m}`));
      log(`${repo}: could not assign the Owner to PR #${pr}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** REQ-001-23: the Reviewer session and its checkout go away once the Review is posted. */
  private finish(sessionId: number, checkout: string) {
    try {
      this.d.runner.close(sessionId);
    } catch {}
    this.d.worktrees.remove(checkout);
  }
}
