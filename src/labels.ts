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
  { name: "agent:reviewed", color: "0e8a16", description: "Review found nothing blocking" },
  { name: "agent:failed", color: "e11d21", description: "The agent gave up; needs the Owner" },
] as const;

export type AgentLabel = (typeof AGENT_LABELS)[number]["name"];

export const isAgentLabel = (name: string): name is AgentLabel => AGENT_LABELS.some((l) => l.name === name);
