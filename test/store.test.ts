import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

const at = (iso: string) => () => new Date(iso);

describe("store", () => {
  test("REQ-001-16 keeps sessions across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const path = join(dir, "state.db");
      const a = new Store(path, at("2026-11-10T10:00:00Z"));
      const id = a.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [5, 6] });
      a.setClaudeSessionId(id, "sess-xyz");
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
        },
      ]);
      b.close();
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

  test("REQ-001-17 keeps the usage-limit pause across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    try {
      const a = new Store(join(dir, "state.db"));
      expect(a.pausedUntil()).toBeUndefined();
      a.setPausedUntil("2026-11-10T15:00:00.000Z");
      a.close();
      const b = new Store(join(dir, "state.db"));
      expect(b.pausedUntil()).toBe("2026-11-10T15:00:00.000Z");
      b.setPausedUntil(undefined);
      expect(b.pausedUntil()).toBeUndefined();
      b.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-001-14 lists Worktrees on record with their issues and PR", () => {
    const s = new Store(":memory:");
    s.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 9 });
    s.updateIssue("octo/app", 6, { worktreePath: "/wt/5", prNumber: 9 });
    s.updateIssue("octo/app", 7, { worktreePath: "/wt/7" });
    s.updateIssue("octo/app", 8, { prNumber: 3 });
    s.updateIssue("octo/other", 1, { worktreePath: "/wt/o1" });
    expect(s.worktrees("octo/app")).toEqual([
      { worktreePath: "/wt/5", issues: [5, 6], prNumber: 9 },
      { worktreePath: "/wt/7", issues: [7], prNumber: null },
    ]);
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
    });
    s.updateIssue("octo/app", 5, { assessmentCommentId: 77, lastHandledCommentId: 12 });
    s.updateIssue("octo/app", 5, { feedbackRounds: 1 });
    expect(s.issue("octo/app", 5)).toMatchObject({
      assessmentCommentId: 77,
      lastHandledCommentId: 12,
      feedbackRounds: 1,
    });
  });
});
