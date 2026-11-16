import type { GitHubClient } from "./github/client.ts";

/** The `agent:*` labels that carry each issue's and PR's state on GitHub (spec 001). */
export const AGENT_LABELS = [
  { name: "agent:planning", color: "c5def5", description: "Planner is assessing this issue" },
  { name: "agent:proposed", color: "0e8a16", description: "Assessment proposes an approach; awaiting Owner approval" },
  { name: "agent:needs-refinement", color: "fbca04", description: "Assessment asks the Owner for details" },
  { name: "agent:wontfix-proposed", color: "cccccc", description: "Assessment proposes not to do this" },
  { name: "agent:approved", color: "1d76db", description: "Approved by the Owner; queued for the Implementer" },
  { name: "agent:blocked", color: "b60205", description: "Approved, but blocked by another open issue" },
  { name: "agent:in-progress", color: "5319e7", description: "Implementer is working on this" },
  { name: "agent:pr-open", color: "006b75", description: "Agent PR is open" },
  { name: "agent:reviewing", color: "d4c5f9", description: "Reviewer is reviewing this PR" },
  { name: "agent:reviewed", color: "0e8a16", description: "Review found nothing to fix" },
  { name: "agent:failed", color: "e11d21", description: "The agent gave up; needs the Owner" },
] as const;

export type AgentLabel = (typeof AGENT_LABELS)[number]["name"];

export const isAgentLabel = (name: string): name is AgentLabel => AGENT_LABELS.some((l) => l.name === name);

/** The labels of the PR phase, which an agent PR shows too (REQ-001-53). */
export const PR_PHASE_LABELS = [
  "agent:pr-open",
  "agent:in-progress",
  "agent:reviewing",
  "agent:reviewed",
  "agent:failed",
] as const satisfies readonly AgentLabel[];

export type PrPhaseLabel = (typeof PR_PHASE_LABELS)[number];

type LabelClient = Pick<GitHubClient, "addLabels" | "removeLabel">;

/**
 * REQ-001-53: the PR shows `label` alone among the PR-phase labels (the only agent labels the Coordinator
 * puts on a PR). For display only: the Coordinator decides from the issue's labels, never the PR's.
 */
export async function labelPr(gh: LabelClient, repo: string, pr: number, label: PrPhaseLabel): Promise<void> {
  for (const l of PR_PHASE_LABELS) if (l !== label) await gh.removeLabel(repo, pr, l);
  await gh.addLabels(repo, pr, [label]);
}

/**
 * Sets a PR-phase label on the issues, removing `clear` from them first, and shows it on their agent PR,
 * if there is one on record (REQ-001-53).
 */
export async function setPrPhase(
  gh: LabelClient,
  repo: string,
  target: { issues: readonly number[]; pr?: number | null },
  label: PrPhaseLabel,
  clear: readonly string[],
): Promise<void> {
  for (const n of target.issues) {
    for (const l of clear) if (l !== label) await gh.removeLabel(repo, n, l);
    await gh.addLabels(repo, n, [label]);
  }
  if (target.pr != null) await labelPr(gh, repo, target.pr, label);
}
