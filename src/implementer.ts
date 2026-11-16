/**
 * Implementer run (REQ-001-06, REQ-001-09): a fresh session in a new Worktree per issue or Bundle;
 * after every turn the Coordinator pushes and opens or updates the PR (REQ-001-19), which stays a
 * draft until its head is reviewed (REQ-001-31). Cleanup once
 * the PR is merged or closed (REQ-001-14).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, roleSettings } from "./config.ts";
import type { GitHubClient, Item } from "./github/client.ts";
import { labelPr, setPrPhase } from "./labels.ts";
import { agentNote, sessionNote } from "./note.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { findingsToAnswer, type ImplementerResult, validateResult } from "./results.ts";
import type { Finding } from "./reviewer.ts";
import type { SessionRunner } from "./runner.ts";
import { checkScreenshots, renderScreenshots } from "./screenshots.ts";
import type { FeedbackCause } from "./state.ts";
import type { Store } from "./store.ts";
import type { Worktrees } from "./worktrees.ts";

const BODY_LIMIT = 6_000;

/** An automatic Feedback round: the head it started at and why it runs (REQ-001-38). */
export interface AutoRound {
  headSha: string;
  causes: FeedbackCause[];
}
/**
 * Labels a re-attached issue loses: every agent label but `agent:pr-open`. A stale one would win over
 * it (REQ-001-16): `agent:failed` would stop automatic rounds, an in-flight one would fail the issue (REQ-001-43).
 */
const CLEARED_ON_REATTACH = [
  "agent:proposed",
  "agent:needs-refinement",
  "agent:wontfix-proposed",
  "agent:approved",
  "agent:blocked",
  "agent:planning",
  "agent:in-progress",
  "agent:reviewing",
  "agent:reviewed",
  "agent:failed",
];
const CLEARED_ON_CLEANUP = ["agent:in-progress", "agent:pr-open", "agent:reviewing", "agent:reviewed", "agent:failed"];

export interface ImplementerDeps {
  config: Config;
  store: Store;
  gh: Pick<GitHubClient, "addLabels" | "removeLabel" | "createComment" | "createPull" | "updatePull" | "setDraft">;
  runner: Pick<SessionRunner, "start" | "resume" | "close" | "sessionDir">;
  worktrees: Pick<
    Worktrees,
    | "create"
    | "attach"
    | "push"
    | "commitsAhead"
    | "currentBranch"
    | "defaultBranch"
    | "remove"
    | "hasRoom"
    | "fetchBase"
    | "head"
    | "publishScreenshots"
  >;
}

export class Implementer {
  constructor(private readonly d: ImplementerDeps) {}

  /** Starts the Implementer for an approved issue and its Bundle (first issue first). */
  async start(repo: string, members: Item[]): Promise<number> {
    const numbers = members.map((i) => i.number);
    const first = members[0];
    if (!first) throw new Error("no issues to implement");
    for (const n of numbers) {
      for (const l of ["agent:approved", "agent:proposed", "agent:blocked"]) await this.d.gh.removeLabel(repo, n, l);
      await this.d.gh.addLabels(repo, n, ["agent:in-progress"]);
    }
    const wt = await this.d.worktrees.create(repo, numbers, first.title);
    for (const n of numbers) this.d.store.updateIssue(repo, n, { worktreePath: wt.path });
    const context = this.context(repo, members, wt.branch);
    return this.d.runner.start({
      repo,
      role: "implementer",
      kind: "issue",
      issues: numbers,
      title: first.title,
      cwd: wt.path,
      prompt: renderPrompt(loadPrompt("implementer", wt.path), { repo, context }),
      model: roleSettings(this.d.config, repo, "implementer"),
      sandboxDomains: this.sandboxDomains(repo),
    });
  }

  /**
   * REQ-001-43: re-attach an orphaned agent PR. Rebuilds its Worktree from the PR's branch, records the
   * PR again and labels the issues `agent:pr-open`, so Reviews and Feedback rounds resume. State of an
   * earlier round in progress is cleared; the issues' Review history and round count are kept.
   */
  async reattach(repo: string, pr: number, branch: string, issues: number[]): Promise<string> {
    const wt = await this.d.worktrees.attach(repo, issues, branch);
    for (const n of issues) {
      this.d.store.updateIssue(repo, n, {
        worktreePath: wt.path,
        prNumber: pr,
        inFeedbackRound: 0,
        autoRound: null,
        pendingFeedback: null,
        reviewFindings: null,
      });
    }
    await setPrPhase(this.d.gh, repo, { issues, pr }, "agent:pr-open", CLEARED_ON_REATTACH);
    const note = agentNote({ owner: this.d.config.owner.login });
    await this.d.gh.createComment(
      repo,
      pr,
      `${note}\n\nThe Coordinator re-attached this PR: it had no Worktree on record, so the Worktree was rebuilt from \`${branch}\`. ` +
        `Reviews and Feedback rounds resume for ${issues.map((n) => `#${n}`).join(", ")}.`,
    );
    return wt.path;
  }

  /** REQ-001-09 / REQ-001-19: after any turn, push and open or update the PR. */
  async sync(sessionId: number): Promise<void> {
    const s = this.d.store.session(sessionId);
    if (s?.role !== "implementer") return;
    const path = join(this.d.runner.sessionDir(sessionId), "result.json");
    const first = this.d.store.issue(s.repo, s.issues[0] ?? 0);
    const check = validateResult(
      "implementer",
      existsSync(path) ? readFileSync(path, "utf8") : undefined,
      s.issues,
      findingsToAnswer(first),
    );
    const note = sessionNote(this.d.config, s);
    this.d.store.patchSession(sessionId, { needsSync: false });

    if (!check.ok) {
      if (s.resultFailures >= 3)
        await this.failAll(
          s.repo,
          s.issues,
          `${note}\n\nThe Implementer could not produce a valid Result: ${check.problem}`,
          sessionId,
          first.prNumber,
        );
      return;
    }
    const result = check.value as ImplementerResult;
    const wt = first.worktreePath;
    if (!wt) return;

    if (first.prNumber === null && this.d.worktrees.commitsAhead(wt) === 0) {
      await this.failAll(
        s.repo,
        s.issues,
        `${note}\n\nThe Implementer finished without committing anything:\n\n${result.summary}`,
        sessionId,
        null,
      );
      return;
    }
    const branch = this.d.worktrees.currentBranch(wt);
    await this.d.worktrees.push(s.repo, wt, branch);
    // REQ-001-50: the Screenshots section follows prBody; a turn without Screenshots keeps the last one.
    const body = (screenshots: string | null) =>
      [note, result.prBody, screenshots, s.issues.map((n) => `Closes #${n}`).join("\n")].filter(Boolean).join("\n\n");
    const listed = result.screenshots?.length ? result.screenshots : null;
    if (first.prNumber === null) {
      const pr = await this.d.gh.createPull(s.repo, {
        title: result.prTitle,
        body: body(null),
        head: branch,
        base: this.d.worktrees.defaultBranch(wt),
      });
      for (const n of s.issues) this.d.store.updateIssue(s.repo, n, { prNumber: pr });
      await setPrPhase(this.d.gh, s.repo, { issues: s.issues, pr }, "agent:pr-open", ["agent:in-progress"]);
      // REQ-001-49: Screenshots are published per PR, so only once it exists.
      if (listed) {
        const section = await this.publishScreenshots(s.repo, s.issues, wt, pr, listed);
        await this.d.gh.updatePull(s.repo, pr, { title: result.prTitle, body: body(section) });
      }
    } else {
      const section = listed
        ? await this.publishScreenshots(s.repo, s.issues, wt, first.prNumber, listed)
        : first.screenshots;
      await this.d.gh.updatePull(s.repo, first.prNumber, { title: result.prTitle, body: body(section) });
      // REQ-001-31: a reviewed PR goes back to draft once a head it was not reviewed at is pushed.
      const unchanged = first.reviewedHeadSha !== null && this.d.worktrees.head(wt) === first.reviewedHeadSha;
      if (first.reviewedHeadSha !== null && !unchanged) {
        await this.d.gh.setDraft(s.repo, first.prNumber, true);
        // REQ-001-52: a round's end below relabels the issues; outside one, `agent:reviewed` must go here.
        if (!first.inFeedbackRound) await this.unreview(s.repo, s.issues, first.prNumber);
      }
      // REQ-001-38: an automatic round that ends without a new commit tells the Owner why the PR waits.
      const auto = first.inFeedbackRound && first.autoRound ? (JSON.parse(first.autoRound) as AutoRound) : null;
      const stall = auto && this.d.worktrees.head(wt) === auto.headSha ? stallText(auto.causes) : null;
      if (first.inFeedbackRound && first.reviewFindings) {
        // REQ-001-35: one comment answering every finding; REQ-001-36: kept for the next Review.
        const answers = renderAnswers(JSON.parse(first.reviewFindings) as Finding[], result.responses ?? []);
        await this.d.gh.createComment(s.repo, first.prNumber, [note, answers, stall].filter(Boolean).join("\n\n"));
        const history = [first.reviewHistory, answers].filter(Boolean).join("\n\n");
        for (const n of s.issues) this.d.store.updateIssue(s.repo, n, { reviewFindings: null, reviewHistory: history });
      } else if (stall) await this.d.gh.createComment(s.repo, first.prNumber, `${note}\n\n${stall}`);
      if (first.inFeedbackRound) {
        for (const n of s.issues) this.d.store.updateIssue(s.repo, n, { inFeedbackRound: 0, autoRound: null });
        const target = { issues: s.issues, pr: first.prNumber };
        await setPrPhase(this.d.gh, s.repo, target, "agent:pr-open", ["agent:in-progress"]);
      }
    }
  }

  /** Fetches the default branch into the issue's Worktree before a round on a conflicting PR (REQ-001-28, REQ-001-37). */
  async fetchBase(repo: string, issues: number[]): Promise<void> {
    const wt = this.d.store.issue(repo, issues[0] ?? 0).worktreePath;
    if (!wt) throw new Error(`no Worktree on record for #${issues[0]}`);
    await this.d.worktrees.fetchBase(repo, wt);
  }

  /**
   * REQ-001-11/12/13: resume the Implementer in its Worktree with the feedback; a session that
   * can't be resumed is replaced by a fresh one in the same Worktree. `auto` is set for an automatic
   * round (REQ-001-38). A round clears `agent:failed`, which only the Owner's rounds can meet (REQ-001-37).
   */
  async feedbackRound(repo: string, pr: number, issues: number[], text: string, auto?: AutoRound): Promise<number> {
    const clear = ["agent:pr-open", "agent:reviewed", "agent:failed"];
    await setPrPhase(this.d.gh, repo, { issues, pr }, "agent:in-progress", clear);
    for (const n of issues)
      this.d.store.updateIssue(repo, n, { inFeedbackRound: 1, autoRound: auto ? JSON.stringify(auto) : null });
    const prompt = `## Feedback round on PR #${pr}\n\n${text}\n\nAddress this with new commits on the same branch, then update your Result (prTitle and prBody describe the whole PR).`;
    const model = roleSettings(this.d.config, repo, "implementer");
    const own = this.d.store.latestSession(repo, issues[0] ?? 0, "implementer");
    let id: number;
    if (own?.claudeSessionId) {
      this.d.runner.resume(own.id, prompt, model);
      id = own.id;
    } else {
      const wt = this.d.store.issue(repo, issues[0] ?? 0).worktreePath;
      if (!wt) throw new Error(`no Worktree on record for #${issues[0]}`);
      id = this.d.runner.start({
        repo,
        role: "implementer",
        kind: "issue",
        issues,
        title: own?.title,
        cwd: wt,
        prompt,
        model,
        sandboxDomains: this.sandboxDomains(repo),
      });
    }
    return id;
  }

  /**
   * REQ-001-14: remove the Worktree, close the sessions and clear the agent labels. Returns false
   * (and changes nothing) while a session is busy, e.g. the Owner is chatting with it (REQ-001-19).
   */
  async cleanup(repo: string, issues: number[], worktreePath: string): Promise<boolean> {
    const sessions = this.d.store.sessions(repo).filter((s) => s.issues.some((n) => issues.includes(n)));
    for (const s of sessions) {
      try {
        this.d.runner.close(s.id);
      } catch {
        return false;
      }
    }
    this.d.worktrees.remove(worktreePath);
    for (const n of issues) {
      for (const l of CLEARED_ON_CLEANUP) await this.d.gh.removeLabel(repo, n, l);
      this.d.store.updateIssue(repo, n, { worktreePath: null, prNumber: null, screenshots: null });
    }
    return true;
  }

  /**
   * REQ-001-49/50/51: checks the listed Screenshots, publishes those that pass for the PR's head and
   * returns the PR body's section, which is kept for later turns. A failed publish never fails the sync.
   */
  private async publishScreenshots(
    repo: string,
    issues: number[],
    wt: string,
    pr: number,
    listed: NonNullable<ImplementerResult["screenshots"]>,
  ): Promise<string> {
    const head = this.d.worktrees.head(wt);
    const { checked, skipped } = checkScreenshots(wt, listed);
    let published: string | undefined;
    let error: string | undefined;
    if (checked.length) {
      try {
        published = await this.d.worktrees.publishScreenshots(repo, pr, head, checked);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const section = renderScreenshots({ repo, pr, head, checked, skipped, published, error });
    for (const n of issues) this.d.store.updateIssue(repo, n, { screenshots: section });
    return section;
  }

  private sandboxDomains(repo: string): string[] {
    return this.d.config.repos.find((r) => r.name.toLowerCase() === repo.toLowerCase())?.sandboxDomains ?? [];
  }

  /**
   * REQ-001-52 / REQ-001-31: a new head outside a Feedback round takes a reviewed PR and its issues back to
   * `agent:pr-open`. Issues without `agent:reviewed` (e.g. `agent:failed` ones) and their PR keep their label.
   */
  private async unreview(repo: string, issues: number[], pr: number) {
    let reviewed = false;
    for (const n of issues) {
      if (!(await this.d.gh.removeLabel(repo, n, "agent:reviewed"))) continue;
      reviewed = true;
      await this.d.gh.addLabels(repo, n, ["agent:pr-open"]);
    }
    if (reviewed) await labelPr(this.d.gh, repo, pr, "agent:pr-open");
    else await this.d.gh.removeLabel(repo, pr, "agent:reviewed");
  }

  private async failAll(repo: string, issues: number[], comment: string, sessionId: number, pr: number | null) {
    await setPrPhase(this.d.gh, repo, { issues, pr }, "agent:failed", ["agent:in-progress"]);
    await this.d.gh.createComment(repo, issues[0] ?? 0, comment);
    try {
      this.d.runner.close(sessionId);
    } catch {}
  }

  private context(repo: string, members: Item[], branch: string): string {
    const numbers = members.map((i) => i.number);
    const parts = ["## Issues", ...members.map((i) => `### #${i.number} ${i.title}\n\n${truncate(i.body)}`)];
    for (const i of members) {
      const rec = this.d.store.issue(repo, i.number);
      if (rec.assessment) parts.push(`## Approved Assessment of #${i.number}`, approach(rec.assessment));
      if (rec.approvalNotes) parts.push(`## The Owner's approval notes on #${i.number}`, rec.approvalNotes);
    }
    parts.push(
      "## Coordination notes",
      numbers.length > 1
        ? `${numbers.map((n) => `#${n}`).join(", ")} are implemented together on this branch; the PR closes all of them.`
        : "None.",
      "## Working copy",
      `You are on branch \`${branch}\`, created from the default branch. Commit locally; the Coordinator pushes and opens the PR.`,
    );
    return parts.join("\n\n");
  }
}

const STALL_REASONS: Record<FeedbackCause, string> = {
  findings: "the Review findings were declined or not fixed",
  checks: "the checks still fail",
  conflicts: "the PR still has merge conflicts with its base branch",
};

/** Why an automatic round stalled and what the Owner can do (REQ-001-38). */
const stallText = (causes: FeedbackCause[]): string =>
  `No new commits in this round, so the PR waits for the Owner: ${causes.map((c) => STALL_REASONS[c]).join("; ")}. ` +
  "Comment `/agent <text>` to have it fixed anyway, mark it ready for review by hand, or merge it by hand.";

type Response = NonNullable<ImplementerResult["responses"]>[number];

const quote = (text: string, indent: string) =>
  text
    .split("\n")
    .map((l) => `${indent}> ${l}`)
    .join("\n");

/** Each Review finding quoted next to the Implementer's answer (REQ-001-35). */
function renderAnswers(findings: Finding[], responses: Response[]): string {
  const items = findings.map((f, i) => {
    const r = responses.find((x) => x.finding === i + 1);
    const answer = r ? `**${r.answer === "fixed" ? "Fixed" : "Declined"}**: ${r.reason}` : "_No answer._";
    return `${i + 1}. **${f.severity}** \`${f.path}:${f.line}\`\n\n${quote(f.body, "   ")}\n\n   ${answer}`;
  });
  return ["## Answers to the Review findings", ...items].join("\n\n");
}

const truncate = (s: string) => (s.length > BODY_LIMIT ? `${s.slice(0, BODY_LIMIT)}\n… (truncated)` : s);

function approach(assessment: string): string {
  try {
    const a = JSON.parse(assessment) as { approach?: string; questions?: string[] };
    return [
      a.approach ?? "",
      ...(a.questions?.length ? ["Open questions:", ...a.questions.map((q) => `- ${q}`)] : []),
    ].join("\n");
  } catch {
    return assessment;
  }
}
