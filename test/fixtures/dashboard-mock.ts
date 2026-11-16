/**
 * Made-up data for the README screenshots of the dashboard (REQ-003-17): invented repositories,
 * issues, PRs, sessions and Events, and a fixed clock, so the images never show this project's
 * own issues and render the same on every run.
 */
import { parseConfig } from "../../src/config.ts";
import type { RepoSnapshot, TickSnapshot } from "../../src/coordinator.ts";
import type { SessionRecord } from "../../src/store.ts";

export const MOCK_NOW = new Date("2026-03-12T14:30:00Z");

export const mockConfig = parseConfig({
  owner: { login: "acme-dev", id: 1001 },
  github: { appId: 123456, privateKeyPath: "/etc/coordinator/app.pem" },
  pollIntervalSec: 60,
  limits: { maxRunning: 2, maxLiveSessions: 3, maxImplementers: 2, maxWorktrees: 5 },
  roles: {
    planner: { model: "opus", effort: "high" },
    implementer: { model: "opus" },
    reviewer: { model: "opus", effort: "high" },
  },
  repos: [
    { name: "acme/storefront", setup: "bun install" },
    { name: "acme/billing-api", setup: "go mod download", sandboxDomains: ["proxy.golang.org"] },
    { name: "acme/docs", roles: { reviewer: { model: "sonnet" } } },
  ],
  dashboard: { host: "127.0.0.1", port: 8080, tokenPath: "/etc/coordinator/dashboard-token" },
});

const at = (minutesAgo: number) => new Date(MOCK_NOW.getTime() - minutesAgo * 60_000).toISOString();

const repo = (r: Partial<RepoSnapshot> & Pick<RepoSnapshot, "repo">): RepoSnapshot => ({
  error: null,
  issues: [],
  pulls: [],
  worktrees: 0,
  ...r,
});

const pullState = (checks: "success" | "pending" | "failure", mergeable: boolean | null) => ({
  headSha: "0000000",
  checks,
  mergeable,
  headSeenAt: at(30),
  state: "open" as const,
});

const session = (
  s: Pick<SessionRecord, "id" | "repo" | "role" | "issues" | "title" | "state" | "modelId"> & {
    startedMin: number;
    activeMin: number;
  },
): SessionRecord & { live: boolean } => ({
  kind: "issue",
  claudeSessionId: `mock-${s.id}`,
  resumeAttempts: 0,
  ownerMessagedAt: null,
  coordinatorPromptPending: false,
  resultFailures: 0,
  needsSync: false,
  usageLimited: false,
  account: null,
  live: true,
  id: s.id,
  repo: s.repo,
  role: s.role,
  issues: s.issues,
  title: s.title,
  state: s.state,
  modelId: s.modelId,
  startedAt: at(s.startedMin),
  lastActivityAt: at(s.activeMin),
});

export const mockSnapshot: TickSnapshot = {
  finishedAt: at(0.4),
  pausedUntil: null,
  repos: [
    repo({
      repo: "acme/storefront",
      worktrees: 3,
      issues: [
        {
          number: 214,
          title: "Checkout button stays disabled after a coupon error",
          labels: ["agent:reviewed"],
          blockedBy: [],
        },
        { number: 221, title: "Add dark mode to the product page", labels: ["agent:in-progress"], blockedBy: [] },
        { number: 225, title: "Cart badge shows a stale count", labels: ["agent:reviewing"], blockedBy: [] },
        { number: 230, title: "Lazy-load images below the fold", labels: ["agent:approved"], blockedBy: [] },
        { number: 233, title: "Search suggestions as you type", labels: ["agent:proposed"], blockedBy: [] },
        { number: 236, title: "Wishlist sharing", labels: ["agent:planning"], blockedBy: [] },
        { number: 238, title: "Localised prices on the product page", labels: ["agent:blocked"], blockedBy: [221] },
      ],
      pulls: [
        {
          number: 240,
          title: "Re-enable checkout after a coupon error",
          labels: ["agent:reviewed"],
          issues: [214],
          feedbackRounds: 0,
          state: pullState("success", true),
        },
        {
          number: 242,
          title: "Refresh the cart badge on every cart change",
          labels: ["agent:reviewing"],
          issues: [225],
          feedbackRounds: 1,
          state: pullState("pending", true),
        },
      ],
    }),
    repo({
      repo: "acme/billing-api",
      worktrees: 1,
      issues: [
        { number: 87, title: "Retry failed webhook deliveries", labels: ["agent:reviewed"], blockedBy: [] },
        {
          number: 91,
          title: "Invoice PDF uses the wrong currency symbol",
          labels: ["agent:needs-refinement"],
          blockedBy: [],
        },
        { number: 94, title: "Migrate to the new tax rates API", labels: ["agent:failed"], blockedBy: [] },
        { number: 96, title: "Rate-limit the public endpoints", labels: [], blockedBy: [] },
      ],
      pulls: [
        {
          number: 99,
          title: "Retry webhook deliveries with exponential backoff",
          labels: ["agent:reviewed"],
          issues: [87],
          feedbackRounds: 1,
          state: pullState("success", true),
        },
      ],
    }),
    repo({
      repo: "acme/docs",
      issues: [{ number: 12, title: "Document the export endpoint", labels: ["agent:approved"], blockedBy: [] }],
    }),
  ],
  sessions: [
    session({
      id: 41,
      repo: "acme/storefront",
      role: "implementer",
      issues: [221],
      title: "Add dark mode to the product page",
      state: "running",
      modelId: "claude-opus-5-5",
      startedMin: 38,
      activeMin: 0.5,
    }),
    session({
      id: 43,
      repo: "acme/storefront",
      role: "reviewer",
      issues: [225],
      title: "Cart badge shows a stale count",
      state: "running",
      modelId: "claude-opus-5-5",
      startedMin: 6,
      activeMin: 0.2,
    }),
    session({
      id: 39,
      repo: "acme/billing-api",
      role: "planner",
      issues: [91],
      title: "Invoice PDF uses the wrong currency symbol",
      state: "idle",
      modelId: "claude-opus-5-5",
      startedMin: 95,
      activeMin: 12,
    }),
  ],
  queue: [
    {
      work: { key: "acme/storefront#230 implement", kind: "implement", role: "implementer", queuedAt: at(20) },
      wait: { kind: "max-running" },
    },
    {
      work: { key: "acme/docs#12 implement", kind: "implement", role: "implementer", queuedAt: at(15) },
      wait: { kind: "max-running" },
    },
    {
      work: { key: "acme/storefront plan", kind: "plan", role: "planner", queuedAt: at(2) },
      wait: { kind: "max-live-sessions" },
    },
  ],
  events: [
    {
      at: at(3),
      repo: "acme/storefront",
      kind: "review-passed",
      issues: [214],
      pr: 240,
      text: "Review of PR #240: no findings, ready for the Owner",
    },
    {
      at: at(9),
      repo: "acme/storefront",
      kind: "pr-opened",
      issues: [225],
      pr: 242,
      text: "Opened PR #242 for #225",
    },
    {
      at: at(24),
      repo: "acme/billing-api",
      kind: "assessed",
      issues: [91],
      pr: null,
      text: "Assessed #91: needs details from the Owner",
    },
    {
      at: at(41),
      repo: "acme/storefront",
      kind: "approved",
      issues: [221],
      pr: null,
      text: "#221 approved by the Owner",
    },
    {
      at: at(52),
      repo: "acme/billing-api",
      kind: "review-passed",
      issues: [87],
      pr: 99,
      text: "Review of PR #99: no findings, ready for the Owner",
    },
    {
      at: at(75),
      repo: "acme/billing-api",
      kind: "failed",
      issues: [94],
      pr: null,
      text: "#94 failed: the tax rates API needs credentials the sandbox can't reach",
    },
    {
      at: at(110),
      repo: "acme/storefront",
      kind: "blocked",
      issues: [238],
      pr: null,
      text: "#238 blocked by #221",
    },
  ],
};
