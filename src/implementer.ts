/**
 * Implementer run (REQ-001-06, REQ-001-09): a fresh session in a new Worktree per issue or Bundle;
 * after every turn the Coordinator pushes and opens or updates the PR (REQ-001-19). Cleanup once
 * the PR is merged or closed (REQ-001-14).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, roleSettings } from "./config.ts";
import type { GitHubClient, Item } from "./github/client.ts";
import { agentNote } from "./note.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";
import { type ImplementerResult, validateResult } from "./results.ts";
import type { SessionRunner } from "./runner.ts";
import type { Store } from "./store.ts";
import type { Worktrees } from "./worktrees.ts";

const BODY_LIMIT = 6_000;
const CLEARED_ON_CLEANUP = ["agent:in-progress", "agent:pr-open", "agent:reviewing", "agent:reviewed", "agent:failed"];

export interface ImplementerDeps {
  config: Config;
  store: Store;
  gh: Pick<GitHubClient, "addLabels" | "removeLabel" | "createComment" | "createPull" | "updatePull">;
  runner: Pick<SessionRunner, "start" | "resume" | "close" | "sessionDir">;
  worktrees: Pick<
    Worktrees,
    "create" | "push" | "commitsAhead" | "currentBranch" | "defaultBranch" | "remove" | "hasRoom" | "fetchBase"
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
      cwd: wt.path,
      prompt: renderPrompt(loadPrompt("implementer", wt.path), { repo, context }),
      model: roleSettings(this.d.config, repo, "implementer"),
      sandboxDomains: this.sandboxDomains(repo),
    });
  }

  /** REQ-001-09 / REQ-001-19: after any turn, push and open or update the PR. */
  async sync(sessionId: number): Promise<void> {
    const s = this.d.store.session(sessionId);
    if (s?.role !== "implementer") return;
    const path = join(this.d.runner.sessionDir(sessionId), "result.json");
    const check = validateResult("implementer", existsSync(path) ? readFileSync(path, "utf8") : undefined, s.issues);
    const model = roleSettings(this.d.config, s.repo, "implementer").model;
    const note = agentNote(model, this.d.config.owner.login);
    const first = this.d.store.issue(s.repo, s.issues[0] ?? 0);
    this.d.store.patchSession(sessionId, { needsSync: false });

    if (!check.ok) {
      if (s.resultFailures >= 3)
        await this.failAll(
          s.repo,
          s.issues,
          `${note}\n\nThe Implementer could not produce a valid Result: ${check.problem}`,
          sessionId,
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
      );
      return;
    }
    const branch = this.d.worktrees.currentBranch(wt);
    await this.d.worktrees.push(s.repo, wt, branch);
    const body = [note, result.prBody, s.issues.map((n) => `Closes #${n}`).join("\n")].join("\n\n");
    if (first.prNumber === null) {
      const pr = await this.d.gh.createPull(s.repo, {
        title: result.prTitle,
        body,
        head: branch,
        base: this.d.worktrees.defaultBranch(wt),
      });
      for (const n of s.issues) {
        this.d.store.updateIssue(s.repo, n, { prNumber: pr });
        await this.d.gh.removeLabel(s.repo, n, "agent:in-progress");
        await this.d.gh.addLabels(s.repo, n, ["agent:pr-open"]);
      }
    } else {
      await this.d.gh.updatePull(s.repo, first.prNumber, { title: result.prTitle, body });
      if (first.inFeedbackRound) {
        for (const n of s.issues) {
          this.d.store.updateIssue(s.repo, n, { inFeedbackRound: 0 });
          await this.d.gh.removeLabel(s.repo, n, "agent:in-progress");
          await this.d.gh.addLabels(s.repo, n, ["agent:pr-open"]);
        }
      }
    }
  }

  /**
   * REQ-001-11/12/13: resume the Implementer in its Worktree with the feedback; a session that
   * can't be resumed is replaced by a fresh one in the same Worktree.
   */
  /** Fetches the default branch into the issue's Worktree before a merge-conflict round (REQ-001-28). */
  async fetchBase(repo: string, issues: number[]): Promise<void> {
    const wt = this.d.store.issue(repo, issues[0] ?? 0).worktreePath;
    if (!wt) throw new Error(`no Worktree on record for #${issues[0]}`);
    await this.d.worktrees.fetchBase(repo, wt);
  }

  async feedbackRound(repo: string, pr: number, issues: number[], text: string): Promise<number> {
    for (const n of issues) {
      for (const l of ["agent:pr-open", "agent:reviewed"]) await this.d.gh.removeLabel(repo, n, l);
      await this.d.gh.addLabels(repo, n, ["agent:in-progress"]);
      this.d.store.updateIssue(repo, n, { inFeedbackRound: 1 });
    }
    await this.d.gh.removeLabel(repo, pr, "agent:reviewed");
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
      this.d.store.updateIssue(repo, n, { worktreePath: null });
    }
    return true;
  }

  private sandboxDomains(repo: string): string[] {
    return this.d.config.repos.find((r) => r.name.toLowerCase() === repo.toLowerCase())?.sandboxDomains ?? [];
  }

  private async failAll(repo: string, issues: number[], comment: string, sessionId: number) {
    for (const n of issues) {
      await this.d.gh.removeLabel(repo, n, "agent:in-progress");
      await this.d.gh.addLabels(repo, n, ["agent:failed"]);
    }
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
