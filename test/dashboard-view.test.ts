import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import type { RepoSnapshot, TickSnapshot } from "../src/coordinator.ts";
import { renderConfig } from "../src/dashboard/config-html.tsx";
import { renderDashboard } from "../src/dashboard/html.tsx";
import { dashboardView, RECENT_SHOWN } from "../src/dashboard/view.ts";
import type { CoordinatorEvent, SessionRecord } from "../src/store.ts";

const config = parseConfig({
  owner: { login: "octo", id: 42 },
  pollIntervalSec: 45,
  limits: { maxWorktrees: 3, maxFeedbackRounds: 2 },
  roles: { planner: { model: "opus", effort: "high" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [
    { name: "octo/app", setup: "bun install", roles: { reviewer: { model: "haiku", effort: "low" } } },
    { name: "octo/lib" },
  ],
  dashboard: {
    host: "0.0.0.0",
    tokenPath: "/secret/dash/token",
    githubLogin: { clientId: "Ov23liClient", clientSecretPath: "/secret/dash/github-client-secret" },
  },
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
  account: null,
  live: true,
  ...s,
});

const repo = (r: Partial<RepoSnapshot> & Pick<RepoSnapshot, "repo">): RepoSnapshot => ({
  error: null,
  issues: [],
  pulls: [],
  worktrees: 0,
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
  events: [],
  ...s,
});

const event = (e: Partial<CoordinatorEvent> = {}): CoordinatorEvent => ({
  at: "2026-11-15T10:20:00.000Z",
  repo: "octo/app",
  kind: "approved",
  issues: [5],
  pr: null,
  text: "#5 approved",
  ...e,
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
        idleTimeout: "30 min",
        idleShare: null,
        closesIn: null,
        name: "#5 Fix login · Implementer · app",
        model: "sonnet",
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
        idleTimeout: "30 min",
        idleShare: 100,
        closesIn: "at the next tick",
        name: "Planner · #6, #7 · app",
        model: "opus",
      },
    ]);
  });

  test("REQ-003-01 running sessions come first, then idle ones, then those whose window is gone", () => {
    const v = dashboardView(
      snapshot({
        sessions: [
          session({ id: 1, role: "reviewer", issues: [1], live: false }),
          session({ id: 2, role: "planner", issues: [2], state: "idle" }),
          session({ id: 3, role: "implementer", issues: [3] }),
          session({ id: 4, role: "planner", issues: [4], state: "idle" }),
          session({ id: 5, role: "reviewer", issues: [5] }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.sessions.map((s) => [s.issues[0]?.number, s.state])).toEqual([
      [3, "running"],
      [5, "running"],
      [2, "idle"],
      [4, "idle"],
      [1, "gone"],
    ]);
  });

  test("REQ-003-01 an idle session shows how long it has been idle out of idleTimeoutMin, as text and as a bar", () => {
    const idleSince = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
    const v = dashboardView(
      snapshot({
        sessions: [
          session({ id: 1, role: "planner", issues: [5], state: "idle", lastActivityAt: idleSince(6) }),
          session({ id: 2, role: "planner", issues: [6], state: "idle", lastActivityAt: idleSince(4) }),
          session({ id: 3, role: "planner", issues: [7], state: "idle", lastActivityAt: idleSince(45) }),
          session({ id: 4, role: "reviewer", issues: [8], live: false }),
        ],
      }),
      parseConfig({ ...config, limits: { ...config.limits, idleTimeoutMin: 30 } }),
      NOW,
    );
    expect(v.sessions.map((s) => [s.idleFor, s.idleTimeout, s.idleShare, s.closesIn])).toEqual([
      ["6 min", "30 min", 20, "in 24 min"],
      ["4 min", "30 min", 10, "in 26 min"],
      ["45 min", "30 min", 100, "at the next tick"],
      [null, "30 min", null, null],
    ]);
    const html = renderDashboard(v);
    // #74: an idle session says it waits and when it closes, never that it is working.
    expect(html).toContain("idle · closes in 24 min");
    expect(html).toMatch(/title="idle 6 min of 30 min"/);
    expect(html).toContain('<span class="block h-full rounded-xs bg-white/35 w-2/10">');
    expect(html).toContain('<span class="block h-full rounded-xs bg-white/35 w-full">');
  });

  test("REQ-003-01 shows the model the session reported, else the configured one", () => {
    const v = dashboardView(
      snapshot({
        sessions: [
          session({ id: 1, role: "reviewer", issues: [5], modelId: "claude-opus-5-5" }),
          session({ id: 2, role: "reviewer", issues: [6] }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.sessions.map((s) => s.model)).toEqual(["claude-opus-5-5", "haiku"]);
  });

  test("REQ-003-01 marks a session whose tmux window is gone", () => {
    const v = dashboardView(
      snapshot({ sessions: [session({ id: 1, role: "reviewer", issues: [5], live: false })] }),
      config,
      NOW,
    );
    expect(v.sessions[0]?.state).toBe("gone");
  });

  test("REQ-003-02 groups the issues into seven columns with counts, in workflow order (also within a column)", () => {
    const issue = (number: number, labels: string[]) => ({ number, title: `I${number}`, labels, blockedBy: [] });
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [
              issue(9, ["agent:failed", "agent:pr-open"]),
              issue(3, ["bug"]),
              issue(2, ["agent:planning"]),
              issue(4, ["agent:proposed"]),
              issue(5, ["agent:needs-refinement"]),
              issue(6, ["agent:wontfix-proposed"]),
              issue(7, ["agent:approved"]),
              issue(8, ["agent:blocked"]),
              issue(10, ["agent:in-progress"]),
              issue(11, ["agent:pr-open"]),
              issue(12, ["agent:reviewing"]),
              issue(13, ["agent:reviewed"]),
            ],
          }),
          repo({ repo: "octo/lib", issues: [issue(1, [])] }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.columns.map((c) => [c.title, c.issues.map((i) => `${i.repo}#${i.number}`)])).toEqual([
      ["Intake", ["octo/app#3", "octo/lib#1", "octo/app#2"]],
      ["Your move", ["octo/app#4", "octo/app#5", "octo/app#6"]],
      ["Approved", ["octo/app#7", "octo/app#8"]],
      ["Building", ["octo/app#10"]],
      ["In review", ["octo/app#11", "octo/app#12"]],
      ["Reviewed", ["octo/app#13"]],
      ["Failed", ["octo/app#9"]],
    ]);
    expect(v.columns[0]?.issues[0]?.url).toBe("https://github.com/octo/app/issues/3");
    expect(dashboardView(snapshot(), config, NOW).columns.map((c) => c.issues.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("REQ-003-02 / REQ-003-17 says in words what is happening or what the Owner must do, toned by meaning", () => {
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [
              { number: 4, title: "A", labels: ["agent:proposed"], blockedBy: [] },
              { number: 5, title: "B", labels: ["agent:needs-refinement"], blockedBy: [] },
              { number: 8, title: "C", labels: ["agent:blocked"], blockedBy: [4, 5] },
              { number: 10, title: "D", labels: ["agent:in-progress"], blockedBy: [] },
              { number: 13, title: "E", labels: ["agent:reviewed"], blockedBy: [] },
              { number: 14, title: "F", labels: ["agent:reviewed"], blockedBy: [] },
              { number: 9, title: "G", labels: ["agent:failed"], blockedBy: [] },
            ],
            pulls: [pull(71, [13], {}), pull(72, [14], { mergeable: false })],
          }),
        ],
      }),
      config,
      NOW,
    );
    const status = Object.fromEntries(v.columns.flatMap((c) => c.issues.map((i) => [i.number, [i.status, i.tone]])));
    expect(status).toEqual({
      4: ["Approve it, or reply to revise", "warn"],
      5: ["Answer the Planner's questions", "warn"],
      8: ["Blocked by #4, #5", "muted"],
      10: ["The Implementer is building it", "acc"],
      13: ["Ready: merge the PR", "ok"],
      14: ["Reviewed; the PR has conflicts or pending checks", "muted"],
      9: ["The Coordinator gave up; see its comment", "bad"],
    });
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
    expect(v.columns.find((c) => c.title === "In review")?.issues[0]?.pr).toEqual({
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
      { key: "octo/app PR #70 feedback", kind: "feedback", status: "starts now", waiting: false },
      {
        key: "octo/app#5 wake",
        kind: "wake",
        status: "waits: its session is busy (the Owner may be chatting)",
        waiting: true,
      },
      { key: "octo/app#5 implement", kind: "implement", status: "waits: maxWorktrees (3) reached", waiting: true },
      {
        key: "octo/app#6 implement",
        kind: "implement",
        status: "waits: all Implementer Slots (1) in use",
        waiting: true,
      },
      { key: "octo/lib plan", kind: "plan", status: "waits: maxRunning (1) reached", waiting: true },
      { key: "octo/lib plan 2", kind: "plan", status: "waits: maxLiveSessions (2) reached", waiting: true },
      {
        key: "octo/lib plan 3",
        kind: "plan",
        status: "waits: usage-limit pause until 2026-11-15 11:00 UTC",
        waiting: true,
      },
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
        roles: [
          { role: "Planner", model: "opus", effort: "high" },
          { role: "Implementer", model: "sonnet", effort: null },
          { role: "Reviewer", model: "haiku", effort: "low" },
        ],
        overrides: [{ role: "Reviewer", model: "haiku", effort: "low" }],
        counts: null,
      },
      expect.objectContaining({ name: "octo/lib", setup: null, overrides: [] }),
    ]);
    expect(v.settings.roles).toEqual([
      { role: "Planner", model: "opus", effort: "high" },
      { role: "Implementer", model: "sonnet", effort: null },
      { role: "Reviewer", model: "opus", effort: null },
    ]);
    expect(v.settings.access).toEqual({ host: "0.0.0.0", port: 8080, tokenRequired: true, githubLogin: "on" });
    const all = JSON.stringify(v) + renderDashboard(v) + renderConfig(v);
    expect(all).not.toContain("/secret");
    expect(all).not.toContain("app.pem");
  });

  test("REQ-003-27 the Config page knows whether the GitHub sign-in is on, off or not set up yet", () => {
    const access = (githubLogin?: false | Record<string, string>) =>
      dashboardView(undefined, parseConfig({ ...config, dashboard: { githubLogin } }), NOW).settings.access
        ?.githubLogin;
    expect(access()).toBe("not set up");
    expect(access(false)).toBe("off");
    expect(access({ clientId: "Ov23li", clientSecretPath: "/s" })).toBe("on");
  });

  test("REQ-003-05 counts each repository's open issues, agent PRs and Worktrees from the last tick", () => {
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [
              { number: 1, title: "A", labels: [], blockedBy: [] },
              { number: 2, title: "B", labels: ["agent:pr-open"], blockedBy: [] },
            ],
            pulls: [pull(70, [2], {})],
            worktrees: 2,
          }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.settings.repos.map((r) => [r.name, r.counts])).toEqual([
      ["octo/app", { issues: 2, pulls: 1, worktrees: 2 }],
      ["octo/lib", null],
    ]);
  });

  test("REQ-003-11 sums up ready PRs, running sessions, what needs the Owner, what is stuck and what waits", () => {
    const issue = (number: number, label: string) => ({ number, title: "x", labels: [label], blockedBy: [] });
    const work = (key: string) => ({ key, kind: "plan" as const, role: "planner" as const, queuedAt: "t" });
    const v = dashboardView(
      snapshot({
        repos: [
          repo({
            repo: "octo/app",
            issues: [
              issue(1, "agent:proposed"),
              issue(2, "agent:needs-refinement"),
              issue(3, "agent:wontfix-proposed"),
              issue(4, "agent:reviewed"),
              issue(5, "agent:failed"),
              issue(6, "agent:blocked"),
              issue(7, "agent:in-progress"),
            ],
            pulls: [pull(70, [4], {})],
          }),
        ],
        sessions: [
          session({ id: 1, role: "implementer", issues: [7] }),
          session({ id: 2, role: "planner", issues: [1], state: "idle" }),
          session({ id: 3, role: "reviewer", issues: [4], live: false }),
        ],
        queue: [{ work: work("a") }, { work: work("b"), wait: { kind: "max-running" } }],
      }),
      config,
      NOW,
    );
    expect(v.summary).toEqual({ ready: 1, working: 1, needYou: 4, stuck: 2, queued: 1 });
  });

  test("REQ-003-12 shows used out of the limit for running and live sessions, each Role's Slots and Worktrees", () => {
    const v = dashboardView(
      snapshot({
        repos: [repo({ repo: "octo/app", worktrees: 2 }), repo({ repo: "octo/lib", worktrees: 1 })],
        sessions: [
          session({ id: 1, role: "implementer", issues: [7] }),
          session({ id: 2, role: "planner", issues: [1], state: "idle" }),
          session({ id: 3, role: "reviewer", issues: [4], live: false }),
        ],
      }),
      config,
      NOW,
    );
    expect(v.capacity).toEqual([
      { label: "Running", used: 1, limit: 1 },
      { label: "Live", used: 2, limit: 2 },
      { label: "Planner Slots", used: 0, limit: 1 },
      { label: "Implementer Slots", used: 1, limit: 1 },
      { label: "Reviewer Slots", used: 0, limit: 1 },
      { label: "Worktrees", used: 3, limit: 3 },
    ]);
  });

  test("REQ-003-13 a picked repository narrows the Pipeline; an unknown one shows all", () => {
    const snap = snapshot({
      repos: [
        repo({ repo: "octo/app", issues: [{ number: 1, title: "A", labels: [], blockedBy: [] }] }),
        repo({ repo: "octo/lib", issues: [{ number: 2, title: "B", labels: [], blockedBy: [] }] }),
      ],
    });
    const picked = dashboardView(snap, config, NOW, { repo: "octo/lib" });
    expect(picked.repoFilter).toBe("octo/lib");
    expect(picked.repos).toEqual(["octo/app", "octo/lib"]);
    expect(picked.columns[0]?.issues.map((i) => i.number)).toEqual([2]);
    const unknown = dashboardView(snap, config, NOW, { repo: "evil/repo" });
    expect(unknown.repoFilter).toBeNull();
    expect(unknown.columns[0]?.issues.map((i) => i.number)).toEqual([1, 2]);
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
    expect(html).toContain('<meta http-equiv="refresh" content="45"/>');
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
    // The page's own scripts (REQ-003-09) are the only ones.
    const html = renderDashboard(v).replace(
      /<script src="\/assets\/(dashboard|meters)\.js\?v=[0-9a-f]+" defer=""><\/script>/g,
      "",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  test("REQ-003-16 shows the newest Events first, at most 15, each with its tone, time and links", () => {
    const many = Array.from({ length: 20 }, (_, n) =>
      event({ issues: [100 - n], text: `#${100 - n} unblocked`, kind: "unblocked" }),
    );
    const v = dashboardView(
      snapshot({
        events: [
          event({ kind: "pr-opened", issues: [5, 6], pr: 70, text: "PR #70 opened for #5, #6: Fix" }),
          event({ kind: "failed", issues: [7], text: "#7 failed: boom", at: "2026-11-15T10:10:00.000Z" }),
          ...many,
        ],
      }),
      config,
      NOW,
    );
    expect(RECENT_SHOWN).toBe(15);
    expect(v.recent).toHaveLength(15);
    expect(v.recent[0]).toEqual({
      repo: "octo/app",
      kind: "pr-opened",
      tone: "ok",
      text: "PR #70 opened for #5, #6: Fix",
      datetime: "2026-11-15T10:20:00.000Z",
      at: "2026-11-15 10:20 UTC",
      ago: "10 min ago",
      links: [
        { label: "PR #70", url: "https://github.com/octo/app/pull/70" },
        { label: "#5", url: "https://github.com/octo/app/issues/5" },
        { label: "#6", url: "https://github.com/octo/app/issues/6" },
      ],
    });
    expect(v.recent[1]).toMatchObject({ kind: "failed", tone: "bad", text: "#7 failed: boom", ago: "20 min ago" });
    expect(v.recent.at(-1)?.text).toBe("#88 unblocked");
  });

  test("REQ-003-16 / REQ-003-17 gives each kind of Event a tone: success, neutral, attention only for the Owner's move, failure", () => {
    const kinds = [
      "assessed",
      "approved",
      "blocked",
      "unblocked",
      "pr-opened",
      "review-passed",
      "review-findings",
      "feedback-round",
      "failed",
    ] as const;
    const v = dashboardView(snapshot({ events: kinds.map((kind) => event({ kind })) }), config, NOW);
    expect(Object.fromEntries(v.recent.map((e) => [e.kind, e.tone]))).toEqual({
      assessed: "warn",
      approved: "muted",
      blocked: "muted",
      unblocked: "muted",
      "pr-opened": "ok",
      "review-passed": "ok",
      "review-findings": "muted",
      "feedback-round": "muted",
      failed: "bad",
    });
  });

  test("REQ-003-16 / REQ-003-13 a picked repository narrows Recent too", () => {
    const events = [
      ...Array.from({ length: 20 }, (_, n) => event({ repo: "octo/app", issues: [n] })),
      event({ repo: "octo/lib", issues: [2], text: "#2 approved" }),
    ];
    const v = dashboardView(snapshot({ events }), config, NOW, { repo: "octo/lib" });
    expect(v.recent.map((e) => e.text)).toEqual(["#2 approved"]);
    expect(v.recent[0]?.links).toEqual([{ label: "#2", url: "https://github.com/octo/lib/issues/2" }]);
  });

  test("REQ-003-16 with no Events yet Recent says so", () => {
    expect(dashboardView(snapshot(), config, NOW).recent).toEqual([]);
    expect(dashboardView(undefined, config, NOW).recent).toEqual([]);
    expect(renderDashboard(dashboardView(snapshot(), config, NOW))).toContain("Nothing has happened yet");
  });

  test("REQ-003-16 / REQ-003-09 titles and failure reasons in Events are shown as text", () => {
    const evil = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const v = dashboardView(
      snapshot({
        events: [
          event({ kind: "failed", text: `#5 failed: ${evil}` }),
          event({ kind: "pr-opened", pr: 70, text: `PR #70 opened for #5: ${evil}` }),
        ],
      }),
      config,
      NOW,
    );
    const html = renderDashboard(v).replace(
      /<script src="\/assets\/(dashboard|meters)\.js\?v=[0-9a-f]+" defer=""><\/script>/g,
      "",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("#5 failed: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});
