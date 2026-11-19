/**
 * Made-up data for the README screenshots of the dashboard (REQ-003-21): fictional repositories,
 * issues, PRs, sessions and Events, and a fixed clock, so the images never show this project's own
 * issues and render the same on every run.
 */
import { type ConfigInput, parseConfig, type Role } from "../../src/config.ts";
import type { RepoSnapshot, TickSnapshot } from "../../src/coordinator.ts";
import type { SessionRecord, TimedIssue, Timing, TimingKind, TimingPhase } from "../../src/store.ts";
import type { TranscriptTail } from "../../src/transcript.ts";

export const MOCK_NOW = new Date("2026-11-18T14:30:00Z");

const MOCK_CONFIG_INPUT = {
  owner: { login: "ada", id: 1 },
  pollIntervalSec: 60,
  autoMerge: "evaluated",
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
} satisfies ConfigInput;

/** The effective config: `config.ts` with one setting the Owner changed on the Config page (REQ-003-36). */
export const MOCK_CONFIG = parseConfig(MOCK_CONFIG_INPUT);

/** `config.ts` alone, for the Config form's "changed" marks: `maxRunning` was 2 there. */
export const MOCK_CONFIG_BASE = parseConfig({
  ...MOCK_CONFIG_INPUT,
  limits: { ...MOCK_CONFIG_INPUT.limits, maxRunning: 2 },
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
  usageLimitResetsAt: null,
  modelId: s.modelId,
  title: s.title,
  startedAt: at(s.startedMinutesAgo),
  account: null,
  transcriptPath: `/mock/transcripts/${s.id}.jsonl`,
  live: true,
});

/** What the mock sessions' transcripts hold, by session id, for the Now line and Open chat (REQ-003-42, REQ-003-43). */
const TRANSCRIPTS: Record<number, TranscriptTail> = {
  31: {
    step: { kind: "tool", text: "Bash · bun test test/header.test.ts", at: at(0.2) },
    chatUrl: "https://claude.ai/code/session_01MockImplementer",
  },
  32: {
    step: { kind: "tool", text: "Read · src/cart/badge.tsx", at: at(0.05) },
    chatUrl: "https://claude.ai/code/session_01MockReviewer",
  },
  33: { step: { kind: "thinking", text: "", at: at(0.5) }, chatUrl: "https://claude.ai/code/session_01MockPlanner" },
  28: {
    step: { kind: "tool", text: "Write · result.json", at: at(18) },
    lastText: { kind: "says", text: "The PR stores a token per customer and card; the tests cover both.", at: at(18) },
    chatUrl: "https://claude.ai/code/session_01MockPayments",
  },
};

/** The dashboard's transcript reader over the mock transcripts. */
export const mockTranscript = (path: string): TranscriptTail | undefined =>
  TRANSCRIPTS[Number(path.match(/(\d+)\.jsonl$/)?.[1])];

export const MOCK_SNAPSHOT: TickSnapshot = {
  finishedAt: at(0.5),
  pausedUntil: null,
  // The single Account's Usage quota (REQ-003-37): resets in 3 h 12 min and on Friday morning.
  accounts: [
    {
      name: "default",
      quota: {
        fiveHour: { usedPercent: 38, resetsAt: "2026-11-18T17:42:00.000Z" },
        sevenDay: { usedPercent: 24, resetsAt: "2026-11-20T09:00:00.000Z" },
        seenAt: at(4),
      },
      pausedUntil: null,
    },
  ],
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

/**
 * Timings of one reviewed issue for the Timings page (REQ-003-34), after the mockup in #125: a revision, one
 * Feedback round and a re-review. Steps that started at once have a zero wait, which the page leaves out.
 */
const timeline: [TimingPhase, TimingKind, Role | null, number, number][] = [
  ["planning", "queued", "planner", 1, 14],
  ["planning", "agent", "planner", 1, 9],
  ["planning", "owner", null, 1, 95],
  ["planning", "queued", "planner", 2, 0],
  ["planning", "agent", "planner", 2, 6],
  ["planning", "owner", null, 2, 40],
  ["building", "queued", "implementer", 1, 22],
  ["building", "agent", "implementer", 1, 48],
  ["review", "checks", null, 1, 7],
  ["review", "queued", "reviewer", 1, 0],
  ["review", "agent", "reviewer", 1, 12],
  ["review", "queued", "implementer", 1, 0],
  ["review", "agent", "implementer", 1, 17],
  ["review", "checks", null, 2, 6],
  ["review", "queued", "reviewer", 2, 0],
  ["review", "agent", "reviewer", 2, 8],
];

const TIMED = { repo: "acme/payments-api", issue: 41, title: "Retry webhooks with exponential backoff" };

export const MOCK_TIMINGS: Timing[] = (() => {
  let minutesAgo = 20 + timeline.reduce((sum, t) => sum + t[4], 0);
  return timeline.map(([phase, kind, role, round, minutes]) => {
    const start = at(minutesAgo);
    minutesAgo -= minutes;
    const end = at(minutesAgo);
    return { ...TIMED, phase, kind, role, round, start, end, sessionId: kind === "agent" ? 100 + round : null };
  });
})();

export const MOCK_TIMED_ISSUES: TimedIssue[] = [
  { ...TIMED, lastAt: at(20) },
  { repo: "acme/storefront", issue: 221, title: "Add a dark mode toggle to the header", lastAt: at(25) },
  { repo: "acme/storefront", issue: 229, title: "Search suggestions are slow on mobile", lastAt: at(90) },
].sort((a, b) => b.lastAt.localeCompare(a.lastAt));

/** The Timings source the page reads (REQ-003-34): only #41 has intervals here; it is the newest. */
export const MOCK_TIMING_SOURCE = {
  timedIssues: () => MOCK_TIMED_ISSUES,
  timings: (repo: string, issue: number) =>
    repo === TIMED.repo && issue === TIMED.issue ? MOCK_TIMINGS : ([] as Timing[]),
};
