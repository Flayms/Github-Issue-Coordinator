import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import type { RepoSnapshot, TickSnapshot } from "../src/coordinator.ts";
import { renderDashboard } from "../src/dashboard/html.ts";
import { dashboardView } from "../src/dashboard/view.ts";
import type { SessionRecord } from "../src/store.ts";

const config = parseConfig({
  owner: { login: "octo", id: 42 },
  github: { appId: 7, privateKeyPath: "/secret/keys/app.pem" },
  pollIntervalSec: 45,
  limits: { maxWorktrees: 3, maxFeedbackRounds: 2 },
  roles: { planner: { model: "opus", effort: "high" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [
    { name: "octo/app", setup: "bun install", roles: { reviewer: { model: "haiku", effort: "low" } } },
    { name: "octo/lib" },
  ],
  dashboard: { host: "0.0.0.0", tokenPath: "/secret/dash/token" },
});

const NOW = new Date("2026-11-15T10:30:00Z");

const session = (s: Partial<SessionRecord & { live: boolean }> & Pick<SessionRecord, "id" | "role" | "issues">) => ({
  repo: "octo/app",
  kind: "issue" as const,
  claudeSessionId: "c",
  state: "running" as const,
  resumeAttempts: 0,
  lastActivityAt: "2026-11-15T10:00:00.000Z",
  ownerMessagedAt: null,
  coordinatorPromptPending: false,
  resultFailures: 0,
  needsSync: false,
  usageLimited: false,
  modelId: null,
  title: null,
  startedAt: "2026-11-15T09:00:00.000Z",
  live: true,
  ...s,
});

const repo = (r: Partial<RepoSnapshot> & Pick<RepoSnapshot, "repo">): RepoSnapshot => ({
  error: null,
  issues: [],
  pulls: [],
  ...r,
});

const pull = (number: number, issues: number[], state: Partial<NonNullable<RepoSnapshot["pulls"][0]["state"]>>) => ({
  number,
  title: `PR ${number}`,
  labels: [],
  issues,
  feedbackRounds: 1,
  state: {
    headSha: "h",
    checks: "success" as const,
    mergeable: true,
    headSeenAt: "t",
    state: "open" as const,
    ...state,
  },
});

const snapshot = (s: Partial<TickSnapshot> = {}): TickSnapshot => ({
  finishedAt: "2026-11-15T10:29:00.000Z",
  pausedUntil: null,
  repos: [],
  sessions: [],
  queue: [],
  ...s,
});

describe("dashboard view", () => {
  test("REQ-003-01 shows each session's Role, repository, issues with titles, state, start, idle time and name", () => {
    const v = dashboardView(
      snapshot({
        repos: [repo({ repo: "octo/app", issues: [{ number: 5, title: "Fix login", labels: [], blockedBy: [] }] })],
        sessions: [
          session({ id: 1, role: "implementer", issues: [5], title: "Fix login" }),
          session({ id: 2, role: "planner", kind: "batch", issues: [6, 7], state: "idle" }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.sessions).toEqual([
      {
        role: "Implementer",
        repo: "octo/app",
        issues: [{ number: 5, title: "Fix login", url: "https://github.com/octo/app/issues/5" }],
        state: "running",
        startedAt: "2026-11-15T09:00:00.000Z",
        idleFor: null,
        name: "#5 Fix login · Implementer · app",
      },
      {
        role: "Planner",
        repo: "octo/app",
        issues: [
          { number: 6, title: "", url: "https://github.com/octo/app/issues/6" },
          { number: 7, title: "", url: "https://github.com/octo/app/issues/7" },
        ],
        state: "idle",
        startedAt: "2026-11-15T09:00:00.000Z",
        idleFor: "30 min",
        name: "Planner · #6, #7 · app",
      },
    ]);
  });

  test("REQ-003-01 marks a session whose tmux window is gone", () => {
    const v = dashboardView(
      snapshot({ sessions: [session({ id: 1, role: "reviewer", issues: [5], live: false })] }),
      config,
      NOW,
    );
    expect(v.sessions[0]?.state).toBe("gone");
  });

  test("REQ-003-02 puts each issue in the column of its phase, in workflow order, leaving out empty columns", () => {
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [
              { number: 9, title: "Failed", labels: ["agent:failed", "agent:pr-open"], blockedBy: [] },
              { number: 3, title: "New", labels: ["bug"], blockedBy: [] },
              { number: 4, title: "Prop", labels: ["agent:proposed"], blockedBy: [] },
            ],
          }),
          repo({ repo: "octo/lib", issues: [{ number: 1, title: "Lib new", labels: [], blockedBy: [] }] }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.columns.map((c) => [c.phase, c.issues.map((i) => `${i.repo}#${i.number}`)])).toEqual([
      ["new", ["octo/app#3", "octo/lib#1"]],
      ["proposed", ["octo/app#4"]],
      ["failed", ["octo/app#9"]],
    ]);
    expect(v.columns[0]?.issues[0]?.url).toBe("https://github.com/octo/app/issues/3");
  });

  test("REQ-003-02 shows an issue's agent PR with its Feedback rounds, checks and mergeability", () => {
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [{ number: 5, title: "A", labels: ["agent:pr-open"], blockedBy: [] }],
            pulls: [pull(70, [5], { checks: "failure", mergeable: false })],
          }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.columns[0]?.issues[0]?.pr).toEqual({
      repo: "octo/app",
      number: 70,
      title: "PR 70",
      url: "https://github.com/octo/app/pull/70",
      issues: [5],
      checks: "failure",
      mergeable: false,
      feedbackRounds: 1,
      maxFeedbackRounds: 2,
    });
  });

  test("REQ-003-03 lists reviewed, mergeable agent PRs with passing (or no) checks as ready to merge", () => {
    const reviewed = (n: number) => ({ number: n, title: `I${n}`, labels: ["agent:reviewed"], blockedBy: [] });
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [reviewed(1), reviewed(2), reviewed(3), reviewed(4), { ...reviewed(5), labels: ["agent:pr-open"] }],
            pulls: [
              pull(71, [1], {}),
              pull(72, [2], { checks: "none" }),
              pull(73, [3], { checks: "pending" }),
              pull(74, [4], { mergeable: null }),
              pull(75, [5], {}),
            ],
          }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.readyToMerge.map((p) => p.number)).toEqual([71, 72]);
  });

  test("REQ-003-03 a Bundle is ready only when all its issues are reviewed", () => {
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [
              { number: 1, title: "A", labels: ["agent:reviewed"], blockedBy: [] },
              { number: 2, title: "B", labels: ["agent:reviewing"], blockedBy: [] },
            ],
            pulls: [pull(71, [1, 2], {})],
          }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.readyToMerge).toEqual([]);
  });

  test("REQ-003-04 shows the queue in order with why each item waits, then the blocked issues", () => {
    const work = (key: string, kind: "plan" | "implement" | "review" | "feedback" | "wake") => ({
      key,
      kind,
      role: kind === "plan" ? ("planner" as const) : ("implementer" as const),
      queuedAt: "t",
    });
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [
              { number: 9, title: "Blocked one", labels: ["agent:blocked"], blockedBy: [6, 8] },
              { number: 6, title: "Blocker", labels: ["agent:proposed"], blockedBy: [] },
            ],
          }),
        ],
        queue: [
          { work: work("octo/app PR #70 feedback", "feedback") },
          { work: work("octo/app#5 wake", "wake"), wait: { kind: "session-busy" } },
          { work: work("octo/app#5 implement", "implement"), wait: { kind: "max-worktrees" } },
          { work: work("octo/app#6 implement", "implement"), wait: { kind: "slot", role: "implementer" } },
          { work: work("octo/lib plan", "plan"), wait: { kind: "max-running" } },
          { work: work("octo/lib plan 2", "plan"), wait: { kind: "max-live-sessions" } },
          { work: work("octo/lib plan 3", "plan"), wait: { kind: "paused", until: "2026-11-15T11:00:00.000Z" } },
        ],
      }),
      config,
      NOW,
    );
    expect(v.queue).toEqual([
      { key: "octo/app PR #70 feedback", status: "starts now", waiting: false },
      { key: "octo/app#5 wake", status: "waits: its session is busy (the Owner may be chatting)", waiting: true },
      { key: "octo/app#5 implement", status: "waits: maxWorktrees (3) reached", waiting: true },
      { key: "octo/app#6 implement", status: "waits: all Implementer Slots (1) in use", waiting: true },
      { key: "octo/lib plan", status: "waits: maxRunning (1) reached", waiting: true },
      { key: "octo/lib plan 2", status: "waits: maxLiveSessions (2) reached", waiting: true },
      { key: "octo/lib plan 3", status: "waits: usage-limit pause until 2026-11-15 11:00 UTC", waiting: true },
    ]);
    expect(v.blocked).toEqual([
      {
        repo: "octo/app",
        number: 9,
        title: "Blocked one",
        url: "https://github.com/octo/app/issues/9",
        blockedBy: [
          { number: 6, url: "https://github.com/octo/app/issues/6" },
          { number: 8, url: "https://github.com/octo/app/issues/8" },
        ],
      },
    ]);
  });

  test("REQ-003-05 shows the effective settings per Role and repository, without secrets", () => {
    const v = dashboardView(snapshot(), config, NOW);
    expect(v.settings.pollIntervalSec).toBe(45);
    expect(v.settings.limits).toEqual(config.limits);
    expect(v.settings.repos).toEqual([
      {
        name: "octo/app",
        setup: "bun install",
        sandboxDomains: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
        roles: [
          { role: "Planner", model: "opus", effort: "high" },
          { role: "Implementer", model: "sonnet", effort: null },
          { role: "Reviewer", model: "haiku", effort: "low" },
        ],
      },
      expect.objectContaining({ name: "octo/lib", setup: null }),
    ]);
    const all = JSON.stringify(v) + renderDashboard(v);
    expect(all).not.toContain("/secret");
    expect(all).not.toContain("app.pem");
  });

  test("REQ-003-06 shows when the last tick finished and reloads every poll interval", () => {
    const v = dashboardView(
      snapshot({ repos: [repo({ repo: "octo/lib", error: "GitHub down" })], pausedUntil: "2026-11-15T11:00:00.000Z" }),
      config,
      NOW,
    );
    expect(v.lastTick).toEqual({ at: "2026-11-15 10:29 UTC", ago: "1 min ago" });
    expect(v.errors).toEqual([{ repo: "octo/lib", error: "GitHub down" }]);
    expect(v.pausedUntil).toBe("2026-11-15 11:00 UTC");
    const html = renderDashboard(v);
    expect(html).toContain('<meta http-equiv="refresh" content="45">');
    expect(html).toContain("2026-11-15 10:29 UTC");
    expect(html).toContain("GitHub down");
  });

  test("REQ-003-06 before the first tick the page says so", () => {
    const v = dashboardView(undefined, config, NOW);
    expect(v.lastTick).toBeNull();
    expect(renderDashboard(v)).toContain("No tick has finished yet");
  });

  test("REQ-003-09 text from GitHub and agents is escaped", () => {
    const evil = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const v = dashboardView(
      snapshot({
        repos: [
          repo({ repo: "octo/app", issues: [{ number: 5, title: evil, labels: [], blockedBy: [] }], error: evil }),
        ],
        sessions: [session({ id: 1, role: "implementer", issues: [5], title: evil })],
      }),
      config,
      NOW,
    );
    const html = renderDashboard(v);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});
