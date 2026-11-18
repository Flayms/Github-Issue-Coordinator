import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS_KEPT, Store } from "../src/store.ts";

const at = (iso: string) => () => new Date(iso);

describe("store", () => {
  test("REQ-001-16 keeps sessions across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      const a = new Store(path, at("2026-11-10T10:00:00Z"));
      const id = a.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [5, 6] });
      a.setClaudeSessionId(id, "sess-xyz");
      a.setAccount(id, "main");
      a.close();

      const b = new Store(path);
      expect(b.sessions("octo/app")).toEqual([
        {
          id,
          repo: "octo/app",
          role: "planner",
          kind: "batch",
          issues: [5, 6],
          claudeSessionId: "sess-xyz",
          state: "running",
          resumeAttempts: 0,
          lastActivityAt: "2026-11-10T10:00:00.000Z",
          ownerMessagedAt: null,
          coordinatorPromptPending: false,
          resultFailures: 0,
          needsSync: false,
          usageLimited: false,
          modelId: null,
          title: null,
          startedAt: "2026-11-10T10:00:00.000Z",
          account: "main",
        },
      ]);
      b.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-001-29 keeps the session's model id, also in a database created before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      const old = new Database(path, { create: true });
      old.exec(
        `CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, role TEXT NOT NULL,
         kind TEXT NOT NULL, issues TEXT NOT NULL, claude_session_id TEXT, state TEXT NOT NULL,
         resume_attempts INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT NOT NULL, owner_messaged_at TEXT,
         coordinator_prompt_pending INTEGER NOT NULL DEFAULT 0, result_failures INTEGER NOT NULL DEFAULT 0,
         needs_sync INTEGER NOT NULL DEFAULT 0, usage_limited INTEGER NOT NULL DEFAULT 0)`,
      );
      old.close();
      const s = new Store(path);
      const id = s.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [5] });
      expect(s.session(id)?.modelId).toBeNull();
      s.setModelId(id, "claude-opus-5-5");
      expect(s.session(id)?.modelId).toBe("claude-opus-5-5");
      s.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-003-01 keeps when a session started, also in a database created before", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      const old = new Database(path, { create: true });
      old.exec(
        `CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, role TEXT NOT NULL,
         kind TEXT NOT NULL, issues TEXT NOT NULL, claude_session_id TEXT, state TEXT NOT NULL,
         resume_attempts INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT NOT NULL, owner_messaged_at TEXT,
         coordinator_prompt_pending INTEGER NOT NULL DEFAULT 0, result_failures INTEGER NOT NULL DEFAULT 0,
         needs_sync INTEGER NOT NULL DEFAULT 0, usage_limited INTEGER NOT NULL DEFAULT 0, model_id TEXT, title TEXT)`,
      );
      old.exec(
        `INSERT INTO sessions (repo, role, kind, issues, state, last_activity_at)
         VALUES ('octo/app', 'reviewer', 'issue', '[4]', 'idle', '2026-11-10T10:00:00Z')`,
      );
      old.close();
      const s = new Store(path, at("2026-11-12T08:00:00Z"));
      expect(s.session(1)?.startedAt).toBeNull();
      const id = s.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
      s.patchSession(id, { state: "idle" });
      expect(s.session(id)?.startedAt).toBe("2026-11-12T08:00:00.000Z");
      s.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-001-33 keeps the session's issue title, also in a database created before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      const old = new Database(path, { create: true });
      old.exec(
        `CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, role TEXT NOT NULL,
         kind TEXT NOT NULL, issues TEXT NOT NULL, claude_session_id TEXT, state TEXT NOT NULL,
         resume_attempts INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT NOT NULL, owner_messaged_at TEXT,
         coordinator_prompt_pending INTEGER NOT NULL DEFAULT 0, result_failures INTEGER NOT NULL DEFAULT 0,
         needs_sync INTEGER NOT NULL DEFAULT 0, usage_limited INTEGER NOT NULL DEFAULT 0, model_id TEXT)`,
      );
      old.exec(
        `INSERT INTO sessions (repo, role, kind, issues, state, last_activity_at)
         VALUES ('octo/app', 'reviewer', 'issue', '[4]', 'idle', '2026-11-10T10:00:00Z')`,
      );
      old.close();
      const s = new Store(path);
      expect(s.session(1)?.title).toBeNull();
      const id = s.createSession({
        repo: "octo/app",
        role: "implementer",
        kind: "issue",
        issues: [5],
        title: "Fix it",
      });
      expect(s.session(id)?.title).toBe("Fix it");
      s.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("tracks session state, activity and resume attempts; closed sessions drop out of the open list", () => {
    let now = "2026-11-10T10:00:00Z";
    const s = new Store(":memory:", () => new Date(now));
    const id = s.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
    now = "2026-11-10T10:05:00Z";
    s.setState(id, "idle");
    s.recordResume(id);
    expect(s.session(id)).toMatchObject({
      state: "idle",
      resumeAttempts: 1,
      lastActivityAt: "2026-11-10T10:05:00.000Z",
    });
    s.setState(id, "closed");
    expect(s.sessions("octo/app")).toEqual([]);
    expect(s.session(id)?.state).toBe("closed");
    expect(s.sessions("octo/other")).toEqual([]);
  });

  test("finds an issue's latest session of a Role, including closed ones, for resuming", () => {
    const s = new Store(":memory:");
    const batch = s.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [5, 6] });
    s.setState(batch, "closed");
    expect(s.latestSession("octo/app", 6, "planner")?.id).toBe(batch);
    const own = s.createSession({ repo: "octo/app", role: "planner", kind: "issue", issues: [6] });
    expect(s.latestSession("octo/app", 6, "planner")?.id).toBe(own);
    expect(s.latestSession("octo/app", 6, "reviewer")).toBeUndefined();
    expect(s.latestSession("octo/app", 7, "planner")).toBeUndefined();
  });

  test("REQ-001-17 keeps each Account's usage-limit pause across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const a = new Store(join(dir, "state.db"));
      expect(a.pausedUntil("main")).toBeUndefined();
      a.setPausedUntil("main", "2026-11-10T15:00:00.000Z");
      a.close();
      const b = new Store(join(dir, "state.db"));
      expect(b.pausedUntil("main")).toBe("2026-11-10T15:00:00.000Z");
      expect(b.pausedUntil("spare")).toBeUndefined();
      b.setPausedUntil("main", undefined);
      expect(b.pausedUntil("main")).toBeUndefined();
      b.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-001-17 the single pause of an older store becomes the first Account's", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const old = new Database(join(dir, "state.db"));
      old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      old.exec("INSERT INTO meta VALUES ('pausedUntil', '2026-11-10T15:00:00.000Z')");
      old.close();
      const s = new Store(join(dir, "state.db"));
      s.adoptLegacyPause("main");
      expect(s.pausedUntil("main")).toBe("2026-11-10T15:00:00.000Z");
      s.adoptLegacyPause("spare");
      expect(s.pausedUntil("spare")).toBeUndefined();
      s.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-004-01 records the Account a session runs on", () => {
    const s = new Store(":memory:");
    const id = s.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [5] });
    expect(s.session(id)?.account).toBeNull();
    s.setAccount(id, "spare");
    expect(s.session(id)?.account).toBe("spare");
  });

  test("REQ-001-14 lists Worktrees on record with their issues and PR", () => {
    const s = new Store(":memory:");
    s.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 9 });
    s.updateIssue("octo/app", 6, { worktreePath: "/wt/5", prNumber: 9 });
    s.updateIssue("octo/app", 7, { worktreePath: "/wt/7" });
    s.updateIssue("octo/app", 8, { prNumber: 3 });
    s.updateIssue("octo/other", 1, { worktreePath: "/wt/o1" });
    s.updateIssue("octo/app", 5, { reviewedHeadSha: "abc" });
    expect(s.worktrees("octo/app")).toEqual([
      {
        worktreePath: "/wt/5",
        issues: [5, 6],
        prNumber: 9,
        reviewedHeadSha: "abc",
        feedbackRounds: 0,
        pendingFeedback: null,
        failedChecksSha: null,
        conflictSha: null,
        headSha: null,
        headSeenAt: null,
      },
      {
        worktreePath: "/wt/7",
        issues: [7],
        prNumber: null,
        reviewedHeadSha: null,
        feedbackRounds: 0,
        pendingFeedback: null,
        failedChecksSha: null,
        conflictSha: null,
        headSha: null,
        headSeenAt: null,
      },
    ]);
  });

  test("REQ-001-28 a store created before the merge-conflict columns existed is migrated", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      const old = new Database(path, { create: true });
      old.exec(`CREATE TABLE issues (repo TEXT NOT NULL, number INTEGER NOT NULL, worktree_path TEXT,
        failed_checks_sha TEXT, PRIMARY KEY (repo, number))`);
      old.exec("INSERT INTO issues (repo, number, worktree_path) VALUES ('octo/app', 5, '/wt/5')");
      old.close();
      const s = new Store(path);
      s.updateIssue("octo/app", 5, { conflictSha: "h1", headSha: "h1", headSeenAt: "2026-11-13T10:00:00.000Z" });
      expect(s.issue("octo/app", 5)).toMatchObject({ worktreePath: "/wt/5", conflictSha: "h1", headSha: "h1" });
      // REQ-001-35 / REQ-001-36: the Review findings and their history are migrated too.
      s.updateIssue("octo/app", 5, { reviewFindings: "[]", reviewHistory: "Earlier" });
      expect(s.issue("octo/app", 5)).toMatchObject({ reviewFindings: "[]", reviewHistory: "Earlier" });
      // REQ-001-38: and the running automatic round.
      s.updateIssue("octo/app", 5, { autoRound: '{"headSha":"h1","causes":["checks"]}' });
      expect(s.issue("octo/app", 5).autoRound).toBe('{"headSha":"h1","causes":["checks"]}');
      s.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-001-34 records Split-off issues per parent, also in a database created before they existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      const old = new Database(path, { create: true });
      old.exec(`CREATE TABLE issues (repo TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY (repo, number))`);
      old.close();
      const s = new Store(path);
      expect(s.splitOffs("octo/app", 5)).toEqual([]);
      s.recordSplitOff("octo/app", 5, { number: 31, title: "Fix the parser" });
      s.recordSplitOff("octo/app", 5, { number: 32, title: "Add tests" });
      s.recordSplitOff("octo/other", 5, { number: 31, title: "Elsewhere" });
      s.close();
      const again = new Store(path);
      expect(again.splitOffs("octo/app", 5)).toEqual([
        { number: 31, title: "Fix the parser" },
        { number: 32, title: "Add tests" },
      ]);
      expect(again.splitOffs("octo/app", 6)).toEqual([]);
      expect(again.splitOffNumbers("octo/app")).toEqual(new Set([31, 32]));
      again.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-001-40 keeps the comments a reply is pending for, also in a database created before they existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      const old = new Database(path, { create: true });
      old.exec(`CREATE TABLE issues (repo TEXT NOT NULL, number INTEGER NOT NULL, PRIMARY KEY (repo, number))`);
      old.exec(`INSERT INTO issues (repo, number) VALUES ('octo/app', 5)`);
      old.close();
      const s = new Store(path);
      expect(s.issue("octo/app", 5).replyTo).toEqual([]);
      s.updateIssue("octo/app", 5, { replyTo: [300, 301] });
      s.close();
      const again = new Store(path);
      expect(again.issue("octo/app", 5).replyTo).toEqual([300, 301]);
      again.updateIssue("octo/app", 5, { replyTo: [] });
      expect(again.issue("octo/app", 5).replyTo).toEqual([]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("keeps per-issue bookkeeping, merging partial updates", () => {
    const s = new Store(":memory:");
    expect(s.issue("octo/app", 5)).toEqual({
      repo: "octo/app",
      number: 5,
      lastHandledCommentId: 0,
      assessmentCommentId: null,
      feedbackRounds: 0,
      reviewedHeadSha: null,
      prNumber: null,
      worktreePath: null,
      assessment: null,
      bodyHash: null,
      approvedAt: null,
      approvalNotes: null,
      pendingFeedback: null,
      lastHandledReviewId: 0,
      failedChecksSha: null,
      conflictSha: null,
      headSha: null,
      headSeenAt: null,
      inFeedbackRound: 0,
      autoRound: null,
      reviewFindings: null,
      reviewHistory: null,
      replyTo: [],
      screenshots: null,
    });
    s.updateIssue("octo/app", 5, { assessmentCommentId: 77, lastHandledCommentId: 12 });
    s.updateIssue("octo/app", 5, { feedbackRounds: 1 });
    expect(s.issue("octo/app", 5)).toMatchObject({
      assessmentCommentId: 77,
      lastHandledCommentId: 12,
      feedbackRounds: 1,
    });
  });

  test("REQ-003-15 records Events with their time and reads them newest first, also after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      let now = "2026-11-16T10:00:00Z";
      const a = new Store(path, () => new Date(now));
      a.recordEvent({ repo: "octo/app", kind: "approved", issues: [5], pr: null, text: "#5 approved" });
      now = "2026-11-16T10:05:00Z";
      a.recordEvent({ repo: "octo/lib", kind: "pr-opened", issues: [6, 7], pr: 70, text: "PR #70 opened for #6, #7" });
      a.close();

      const b = new Store(path);
      expect(b.events()).toEqual([
        {
          at: "2026-11-16T10:05:00.000Z",
          repo: "octo/lib",
          kind: "pr-opened",
          issues: [6, 7],
          pr: 70,
          text: "PR #70 opened for #6, #7",
        },
        {
          at: "2026-11-16T10:00:00.000Z",
          repo: "octo/app",
          kind: "approved",
          issues: [5],
          pr: null,
          text: "#5 approved",
        },
      ]);
      b.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-003-15 keeps only the newest 200 Events", () => {
    const s = new Store(":memory:");
    expect(EVENTS_KEPT).toBe(200);
    for (let n = 1; n <= EVENTS_KEPT + 5; n++)
      s.recordEvent({ repo: "octo/app", kind: "unblocked", issues: [n], pr: null, text: `#${n} unblocked` });
    const events = s.events();
    expect(events).toHaveLength(EVENTS_KEPT);
    expect(events[0]?.issues).toEqual([EVENTS_KEPT + 5]);
    expect(events.at(-1)?.issues).toEqual([6]);
  });

  describe("Timings", () => {
    const time = (min: number) => new Date(Date.UTC(2026, 10, 18, 10, min)).toISOString();
    const clock = (start: number) => {
      let min = start;
      return { now: () => new Date(time(min)), at: (m: number) => (min = m) };
    };
    const pick = (s: Store, issue = 5) =>
      s.timings("octo/app", issue).map((t) => ({
        phase: t.phase,
        kind: t.kind,
        role: t.role,
        round: t.round,
        start: t.start,
        end: t.end,
      }));

    test("REQ-003-32 a step records its wait, and the session's running time, not its idle time, as agent time", () => {
      const c = clock(14);
      const s = new Store(":memory:", c.now);
      s.beginStep("octo/app", 5, { phase: "planning", role: "planner", title: "Dark mode", queuedAt: time(0) });
      const id = s.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [5] });
      c.at(23);
      s.patchSession(id, { state: "idle", needsSync: true });
      c.at(30);
      s.patchSession(id, { needsSync: false }); // no state change: nothing recorded
      s.patchSession(id, { state: "running", ownerMessagedAt: time(30) }); // the Owner chats with it
      s.patchSession(id, { state: "running" }); // already running: still one interval
      c.at(32);
      s.setState(id, "closed");
      expect(pick(s)).toEqual([
        { phase: "planning", kind: "queued", role: "planner", round: 1, start: time(0), end: time(14) },
        { phase: "planning", kind: "agent", role: "planner", round: 1, start: time(14), end: time(23) },
        { phase: "planning", kind: "agent", role: "planner", round: 1, start: time(30), end: time(32) },
      ]);
      expect(s.timings("octo/app", 5)[1]).toMatchObject({ sessionId: id, title: "Dark mode" });
      // A session of another Role, or one without a step, records nothing.
      s.createSession({ repo: "octo/app", role: "reviewer", kind: "issue", issues: [5] });
      s.createSession({ repo: "octo/app", role: "planner", kind: "issue", issues: [6] });
      expect(pick(s)).toHaveLength(3);
      expect(pick(s, 6)).toEqual([]);
    });

    test("REQ-003-32 Timings survive a restart; an interval left open by a crash is closed when a Tick notices it", () => {
      const dir = mkdtempSync(join(tmpdir(), "store-"));
      try {
        const path = join(dir, "state.db");
        const c = clock(0);
        const a = new Store(path, c.now);
        for (const n of [5, 6])
          a.beginStep("octo/app", n, { phase: "building", role: "implementer", queuedAt: time(0) });
        const crashed = a.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
        const alive = a.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [6] });
        a.close();

        c.at(40);
        const b = new Store(path, c.now);
        b.closeInterruptedTimings(new Set([alive]));
        expect(b.timings("octo/app", 5).at(-1)).toMatchObject({ sessionId: crashed, start: time(0), end: time(40) });
        expect(b.timings("octo/app", 6).at(-1)).toMatchObject({ sessionId: alive, start: time(0), end: null });
        // Resumed after the restart: a new interval of the same step.
        c.at(41);
        b.patchSession(crashed, { state: "running" });
        expect(pick(b).slice(1)).toEqual([
          { phase: "building", kind: "agent", role: "implementer", round: 1, start: time(0), end: time(40) },
          { phase: "building", kind: "agent", role: "implementer", round: 1, start: time(41), end: null },
        ]);
        b.close();
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    test("REQ-003-32 a start tried again stays the same round; the next step is a new round that starts where the last ended", () => {
      const c = clock(10);
      const s = new Store(":memory:", c.now);
      s.beginStep("octo/app", 5, { phase: "planning", role: "planner", queuedAt: time(0) });
      c.at(12);
      s.beginStep("octo/app", 5, { phase: "planning", role: "planner", queuedAt: time(0) }); // the first start failed
      const id = s.createSession({ repo: "octo/app", role: "planner", kind: "issue", issues: [5] });
      c.at(20);
      s.patchSession(id, { state: "idle" });
      c.at(50);
      // A queue time before the last end (e.g. the issue's creation, when it is planned anew) starts at the last end.
      s.beginStep("octo/app", 5, { phase: "planning", role: "planner", queuedAt: time(0) });
      expect(pick(s)).toEqual([
        { phase: "planning", kind: "queued", role: "planner", round: 1, start: time(0), end: time(12) },
        { phase: "planning", kind: "agent", role: "planner", round: 1, start: time(12), end: time(20) },
        { phase: "planning", kind: "queued", role: "planner", round: 2, start: time(20), end: time(50) },
      ]);
    });

    test("REQ-003-32 the Owner's time and checks fill the gap since the last interval; once per head, and never for an issue without Timings", () => {
      const c = clock(10);
      const s = new Store(":memory:", c.now);
      s.recordWait("octo/app", 5, { phase: "planning", kind: "owner", end: time(10) }); // no backfill
      expect(pick(s)).toEqual([]);

      s.beginStep("octo/app", 5, { phase: "building", role: "implementer", queuedAt: time(0) });
      const id = s.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
      c.at(30);
      s.patchSession(id, { state: "idle" });
      c.at(37);
      s.recordWait("octo/app", 5, { phase: "review", kind: "checks", end: time(37), headSha: "h1" });
      c.at(38);
      s.recordWait("octo/app", 5, { phase: "review", kind: "checks", end: time(38), headSha: "h1" }); // same head
      s.recordWait("octo/app", 5, { phase: "review", kind: "owner", end: time(20) }); // before the last end
      c.at(90);
      s.recordWait("octo/app", 5, { phase: "review", kind: "owner", end: time(90) });
      expect(pick(s).slice(2)).toEqual([
        { phase: "review", kind: "checks", role: null, round: 1, start: time(30), end: time(37) },
        { phase: "review", kind: "owner", role: null, round: 1, start: time(37), end: time(90) },
      ]);
      expect(s.hasTimings("octo/app", 5)).toBe(true);
      expect(s.hasTimings("octo/app", 6)).toBe(false);
    });

    test("REQ-003-33 lists the issues with Timings, the most recently active first, with their title", () => {
      const c = clock(0);
      const s = new Store(":memory:", c.now);
      s.beginStep("octo/app", 5, { phase: "planning", role: "planner", title: "Old", queuedAt: time(0) });
      c.at(5);
      s.beginStep("acme/web", 9, { phase: "planning", role: "planner", title: "Other", queuedAt: time(0) });
      c.at(9);
      s.beginStep("octo/app", 5, { phase: "building", role: "implementer", title: "Renamed", queuedAt: time(8) });
      expect(s.timedIssues()).toEqual([
        { repo: "octo/app", issue: 5, title: "Renamed", lastAt: time(9) },
        { repo: "acme/web", issue: 9, title: "Other", lastAt: time(5) },
      ]);
    });
  });
});
