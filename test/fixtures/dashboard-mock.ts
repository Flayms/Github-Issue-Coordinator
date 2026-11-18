/**
 * Made-up data for the README screenshots of the dashboard (REQ-003-21): fictional repositories,
 * issues, PRs, sessions and Events, and a fixed clock, so the images never show this project's own
 * issues and render the same on every run.
 */
import { parseConfig } from "../../src/config.ts";
import type { RepoSnapshot, TickSnapshot } from "../../src/coordinator.ts";
import type { SessionRecord } from "../../src/store.ts";

export const MOCK_NOW = new Date("2026-11-18T14:30:00Z");

export const MOCK_CONFIG = parseConfig({
  owner: { login: "ada", id: 1 },
  pollIntervalSec: 60,
  limits: { maxRunning: 3, maxLiveSessions: 5, maxWorktrees: 6, maxFeedbackRounds: 3 },
  roles: {
    planner: { model: "opus", effort: "high" },
    implementer: { model: "opus" },
    reviewer: { model: "sonnet", effort: "high" },
  },
  repos: [
    { name: "acme/storefront", setup: "bun install" },
    { name: "acme/payments-api", setup: "go mod download", roles: { reviewer: { model: "opus" } } },
    { name: "acme/design-system" },
  ],
  dashboard: {
    host: "127.0.0.1",
    port: 8080,
    tokenPath: "/etc/coordinator/dashboard-token",
    githubLogin: { clientId: "Ov23liMock", clientSecretPath: "/etc/coordinator/github-client-secret" },
  },
});

const at = (minutesAgo: number) => new Date(MOCK_NOW.getTime() - minutesAgo * 60_000).toISOString();

const pull = (
  number: number,
  title: string,
  issues: number[],
  o: {
    checks?: "success" | "failure" | "pending";
    mergeable?: boolean | null;
    rounds?: number;
    labels?: string[];
  } = {},
): RepoSnapshot["pulls"][number] => ({
  number,
  title,
  labels: o.labels ?? [],
  issues,
  feedbackRounds: o.rounds ?? 0,
  state: {
    headSha: `sha${number}`,
    checks: o.checks ?? "success",
    mergeable: o.mergeable ?? true,
    headSeenAt: at(30),
    state: "open",
  },
});

const session = (
  s: Pick<SessionRecord, "id" | "repo" | "role" | "issues" | "state" | "modelId" | "title"> & {
    activeMinutesAgo: number;
    startedMinutesAgo: number;
    kind?: SessionRecord["kind"];
  },
): SessionRecord & { live: boolean } => ({
  id: s.id,
  repo: s.repo,
  role: s.role,
  kind: s.kind ?? "issue",
  issues: s.issues,
  claudeSessionId: `mock-${s.id}`,
  state: s.state,
  resumeAttempts: 0,
  lastActivityAt: at(s.activeMinutesAgo),
  ownerMessagedAt: null,
  coordinatorPromptPending: false,
  resultFailures: 0,
  needsSync: false,
  usageLimited: false,
  modelId: s.modelId,
  title: s.title,
  startedAt: at(s.startedMinutesAgo),
  account: null,
  live: true,
});

export const MOCK_SNAPSHOT: TickSnapshot = {
  finishedAt: at(0.5),
  pausedUntil: null,
  repos: [
    {
      repo: "acme/storefront",
      error: null,
      worktrees: 3,
      issues: [
        {
          number: 212,
          title: "Show delivery estimates on the product page",
          labels: ["agent:reviewed"],
          blockedBy: [],
        },
        {
          number: 218,
          title: "Cart badge doesn't update after removing an item",
          labels: ["agent:reviewing"],
          blockedBy: [],
        },
        { number: 221, title: "Add a dark mode toggle to the header", labels: ["agent:in-progress"], blockedBy: [] },
        { number: 224, title: "Remember the last used payment method", labels: ["agent:blocked"], blockedBy: [221] },
        { number: 227, title: "Wishlist: share a list by link", labels: ["agent:proposed"], blockedBy: [] },
        { number: 229, title: "Search suggestions are slow on mobile", labels: ["agent:planning"], blockedBy: [] },
      ],
      pulls: [
        pull(230, "Show delivery estimates on the product page", [212], { rounds: 1, labels: ["agent:reviewed"] }),
        pull(231, "Update the cart badge when an item is removed", [218], {
          checks: "success",
          labels: ["agent:reviewing"],
        }),
      ],
    },
    {
      repo: "acme/payments-api",
      error: null,
      worktrees: 2,
      issues: [
        { number: 37, title: "Store tokenized cards per customer", labels: ["agent:pr-open"], blockedBy: [] },
        { number: 41, title: "Retry webhooks with exponential backoff", labels: ["agent:reviewed"], blockedBy: [] },
        {
          number: 44,
          title: "Refunds for partially shipped orders",
          labels: ["agent:needs-refinement"],
          blockedBy: [],
        },
        { number: 46, title: "Migrate to the new currency rounding rules", labels: ["agent:failed"], blockedBy: [] },
      ],
      pulls: [
        pull(48, "Store tokenized cards per customer", [37], {
          checks: "pending",
          mergeable: null,
          rounds: 2,
          labels: ["agent:pr-open"],
        }),
        pull(49, "Retry webhooks with exponential backoff", [41], { labels: ["agent:reviewed"] }),
        pull(50, "Currency rounding: apply the 2027 rules", [46], {
          checks: "failure",
          rounds: 3,
          labels: ["agent:failed"],
        }),
      ],
    },
    {
      repo: "acme/design-system",
      error: null,
      worktrees: 0,
      issues: [
        {
          number: 9,
          title: "Button focus ring is invisible on dark backgrounds",
          labels: ["agent:approved"],
          blockedBy: [],
        },
        { number: 12, title: "Document the spacing scale", labels: [], blockedBy: [] },
      ],
      pulls: [],
    },
  ],
  sessions: [
    session({
      id: 31,
      repo: "acme/storefront",
      role: "implementer",
      issues: [221],
      state: "running",
      modelId: "claude-opus-5-5",
      title: "Add a dark mode toggle to the header",
      activeMinutesAgo: 1,
      startedMinutesAgo: 24,
    }),
    session({
      id: 32,
      repo: "acme/storefront",
      role: "reviewer",
      issues: [218],
      state: "running",
      modelId: "claude-sonnet-5-5",
      title: "Cart badge doesn't update after removing an item",
      activeMinutesAgo: 0,
      startedMinutesAgo: 6,
    }),
    session({
      id: 33,
      repo: "acme/storefront",
      role: "planner",
      kind: "batch",
      issues: [229],
      state: "running",
      modelId: "claude-opus-5-5",
      title: null,
      activeMinutesAgo: 2,
      startedMinutesAgo: 3,
    }),
    session({
      id: 28,
      repo: "acme/payments-api",
      role: "implementer",
      issues: [37],
      state: "idle",
      modelId: "claude-opus-5-5",
      title: "Store tokenized cards per customer",
      activeMinutesAgo: 18,
      startedMinutesAgo: 140,
    }),
  ],
  queue: [
    {
      work: { key: "acme/design-system#9 implement", kind: "implement", role: "implementer", queuedAt: at(12) },
      wait: { kind: "slot", role: "implementer" },
    },
    {
      work: { key: "acme/payments-api#48 review", kind: "review", role: "reviewer", queuedAt: at(4) },
      wait: { kind: "slot", role: "reviewer" },
    },
    {
      work: { key: "acme/design-system plan", kind: "plan", role: "planner", queuedAt: at(1) },
      wait: { kind: "slot", role: "planner" },
    },
    {
      work: { key: "acme/storefront#227 revise", kind: "revise", role: "planner", queuedAt: at(1) },
      wait: { kind: "slot", role: "planner" },
    },
    {
      work: { key: "acme/payments-api#44 revise", kind: "revise", role: "planner", queuedAt: at(0.8) },
      wait: { kind: "slot", role: "planner" },
    },
    {
      work: { key: "acme/storefront plan", kind: "plan", role: "planner", queuedAt: at(0.6) },
      wait: { kind: "slot", role: "planner" },
    },
  ],
  events: [
    {
      at: at(5),
      repo: "acme/storefront",
      kind: "pr-opened",
      issues: [218],
      pr: 231,
      text: "PR #231 opened for #218",
    },
    {
      at: at(14),
      repo: "acme/payments-api",
      kind: "review-passed",
      issues: [41],
      pr: 49,
      text: "Review of PR #49: no findings, ready for the Owner",
    },
    {
      at: at(22),
      repo: "acme/payments-api",
      kind: "failed",
      issues: [46],
      pr: 50,
      text: "#46 failed: checks still failing after 3 Feedback rounds",
    },
    {
      at: at(26),
      repo: "acme/storefront",
      kind: "approved",
      issues: [221],
      pr: null,
      text: "#221 approved by the Owner",
    },
    {
      at: at(41),
      repo: "acme/payments-api",
      kind: "feedback-round",
      issues: [37],
      pr: 48,
      text: "Feedback round 2 on PR #48: 2 Review findings",
    },
    {
      at: at(55),
      repo: "acme/storefront",
      kind: "review-passed",
      issues: [212],
      pr: 230,
      text: "Review of PR #230: no findings, ready for the Owner",
    },
    {
      at: at(63),
      repo: "acme/storefront",
      kind: "assessed",
      issues: [227],
      pr: null,
      text: "Assessment for #227: proposed",
    },
    {
      at: at(80),
      repo: "acme/payments-api",
      kind: "assessed",
      issues: [44],
      pr: null,
      text: "Assessment for #44: needs refinement",
    },
    {
      at: at(95),
      repo: "acme/storefront",
      kind: "blocked",
      issues: [224],
      pr: null,
      text: "#224 blocked by #221",
    },
    {
      at: at(130),
      repo: "acme/payments-api",
      kind: "review-findings",
      issues: [37],
      pr: 48,
      text: "Review of PR #48: 2 findings",
    },
  ],
};
