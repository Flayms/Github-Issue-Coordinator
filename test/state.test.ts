import { describe, expect, test } from "bun:test";
import type { ChecksState, Item } from "../src/github/client.ts";
import { deriveActions, issueState, type Snapshot } from "../src/state.ts";
import type { SessionRecord, WorktreeRecord } from "../src/store.ts";

const OWNER = { login: "octo", id: 42 };

const issue = (number: number, labels: string[] = [], extra: Partial<Item> = {}): Item => ({
  number,
  title: `Issue ${number}`,
  body: "",
  author: OWNER,
  labels,
  isPullRequest: false,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  ...extra,
});

const session = (s: Partial<SessionRecord> & Pick<SessionRecord, "role" | "issues">): SessionRecord => ({
  id: 1,
  repo: "octo/app",
  kind: "issue",
  claudeSessionId: "sess-1",
  state: "running",
  resumeAttempts: 0,
  lastActivityAt: "2026-11-10T00:00:00Z",
  ownerMessagedAt: null,
  coordinatorPromptPending: false,
  resultFailures: 0,
  needsSync: false,
  usageLimited: false,
  modelId: null,
  ...s,
});

const NOW_ISO = "2026-11-11T12:00:00.000Z";
const snap = (s: Partial<Snapshot>): Snapshot => ({
  now: NOW_ISO,
  repo: "octo/app",
  ownerId: OWNER.id,
  items: [],
  sessions: [],
  liveSessionIds: new Set(),
  ...s,
});

describe("issue state from labels", () => {
  test("no agent label means new; the most advanced agent label wins", () => {
    expect(issueState(["bug"])).toBe("new");
    expect(issueState(["agent:proposed"])).toBe("proposed");
    expect(issueState(["agent:proposed", "agent:approved"])).toBe("approved");
    expect(issueState(["agent:pr-open", "agent:failed"])).toBe("failed");
  });
});

describe("deriveActions", () => {
  test("REQ-001-02 queues every new Owner issue for one Planner pass", () => {
    const actions = deriveActions(snap({ items: [issue(1), issue(2, ["bug"]), issue(3, ["agent:proposed"])] }));
    expect(actions).toEqual([{ type: "plan", repo: "octo/app", issues: [1, 2] }]);
  });

  test("REQ-001-03 Owner feedback on a proposal, or an edited body, queues a plan revision", () => {
    const feedback = { id: 11, body: "Use v2", author: OWNER, createdAt: "", updatedAt: "" };
    const wake = { id: 12, body: "/wake", author: OWNER, createdAt: "", updatedAt: "" };
    const sneaky = { id: 13, body: "sneaky", author: { login: "mallory", id: 666 }, createdAt: "", updatedAt: "" };
    const comments = [feedback, wake, sneaky];
    const actions = deriveActions(
      snap({
        items: [
          issue(5, ["agent:proposed"]),
          issue(6, ["agent:needs-refinement"]),
          issue(7, ["agent:wontfix-proposed"]),
        ],
        feedback: new Map([
          [5, { comments, bodyChanged: false }],
          [6, { comments: [], bodyChanged: true }],
          [7, { comments: [wake, sneaky], bodyChanged: false }],
        ]),
      }),
    );
    expect(actions.filter((a) => a.type === "revise")).toEqual([
      { type: "revise", repo: "octo/app", issue: 5, comments: [feedback], bodyChanged: false },
      { type: "revise", repo: "octo/app", issue: 6, comments: [], bodyChanged: true },
    ]);
  });

  test("REQ-001-03 feedback on an issue that is not a proposal does not revise the plan", () => {
    const comments = [{ id: 11, body: "Use v2", author: OWNER, createdAt: "", updatedAt: "" }];
    const actions = deriveActions(
      snap({ items: [issue(5, ["agent:approved"])], feedback: new Map([[5, { comments, bodyChanged: true }]]) }),
    );
    expect(actions).toEqual([]);
  });

  const c = (id: number, body: string, author = OWNER) => ({
    id,
    body,
    author,
    createdAt: `2026-11-11T0${id % 10}:00:00Z`,
    updatedAt: "",
  });
  const assessment = (blockedBy: number[] = []) =>
    JSON.stringify({ issue: 5, verdict: "proposed", approach: "A", bundleWith: [], blockedBy, questions: [] });

  test("REQ-001-04 the Owner's /approve on a proposal approves it, with earlier feedback in the notes", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:proposed"])],
        feedback: new Map([[5, { comments: [c(21, "Also log it"), c(22, "/approve ship it")], bodyChanged: false }]]),
      }),
    );
    expect(actions).toEqual([
      {
        type: "approve",
        repo: "octo/app",
        issue: 5,
        notes: "Also log it\n\nship it",
        at: "2026-11-11T02:00:00Z",
        upToCommentId: 22,
      },
    ]);
  });

  test("REQ-001-04 /approve by anyone else, or on an issue that is not proposed, approves nothing", () => {
    const mallory = { login: "mallory", id: 666 };
    expect(
      deriveActions(
        snap({
          items: [issue(5, ["agent:proposed"])],
          feedback: new Map([[5, { comments: [c(21, "/approve", mallory)], bodyChanged: false }]]),
        }),
      ),
    ).toEqual([]);
    expect(
      deriveActions(
        snap({
          items: [issue(5, ["agent:needs-refinement"])],
          feedback: new Map([[5, { comments: [c(21, "/approve")], bodyChanged: false }]]),
        }),
      ),
    ).toEqual([]);
  });

  test("REQ-001-04 an agent:approved label added by the Owner approves the issue", () => {
    const actions = deriveActions(
      snap({ items: [issue(5, ["agent:proposed", "agent:approved"])], labelActors: new Map([[5, OWNER]]) }),
    );
    expect(actions).toEqual([
      { type: "approve", repo: "octo/app", issue: 5, notes: "", at: NOW_ISO, upToCommentId: 0 },
    ]);
  });

  test("REQ-001-04 an agent:approved label added by anyone else is removed", () => {
    for (const actor of [{ login: "mallory", id: 666 }, undefined]) {
      const actions = deriveActions(
        snap({ items: [issue(5, ["agent:proposed", "agent:approved"])], labelActors: new Map([[5, actor]]) }),
      );
      expect(actions).toEqual([{ type: "reject-approval", repo: "octo/app", issue: 5 }]);
    }
  });

  test("REQ-001-04 an approval already on record needs no label check", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:approved"])],
        records: new Map([[5, { approvedAt: "x", assessment: assessment() }]]),
      }),
    );
    expect(actions.filter((a) => a.type === "reject-approval" || a.type === "approve")).toEqual([]);
  });

  test("REQ-001-05 an approved issue blocked by an open issue gets agent:blocked", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:approved"]), issue(8, ["agent:proposed"])],
        records: new Map([[5, { approvedAt: "x", assessment: assessment([8, 99]) }]]),
      }),
    );
    expect(actions).toContainEqual({ type: "block", repo: "octo/app", issue: 5, blockers: [8] });
  });

  test("REQ-001-05 a blocked issue returns to agent:approved once its blockers are closed", () => {
    const records = new Map([[5, { approvedAt: "x", assessment: assessment([8]) }]]);
    expect(deriveActions(snap({ items: [issue(5, ["agent:blocked"])], records }))).toEqual([
      { type: "unblock", repo: "octo/app", issue: 5 },
    ]);
    expect(deriveActions(snap({ items: [issue(5, ["agent:blocked"]), issue(8)], records }))).not.toContainEqual(
      expect.objectContaining({ type: "unblock" }),
    );
  });

  const bundleAssessment = (issue: number, bundleWith: number[] = [], blockedBy: number[] = []) =>
    JSON.stringify({ issue, verdict: "proposed", approach: "A", bundleWith, blockedBy, questions: [] });

  test("REQ-001-09 an approved, unblocked issue without an Implementer is queued for implementation", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:approved"])],
        records: new Map([[5, { approvedAt: "2026-11-11T09:00:00Z", assessment: bundleAssessment(5) }]]),
      }),
    );
    expect(actions).toEqual([{ type: "implement", repo: "octo/app", issues: [5], approvedAt: "2026-11-11T09:00:00Z" }]);
  });

  test("REQ-001-06 a Bundle takes in the open issues it is bundled with, once", () => {
    const actions = deriveActions(
      snap({
        items: [
          issue(5, ["agent:approved"]),
          issue(6, ["agent:approved"]),
          issue(7, ["agent:proposed"]),
          issue(8, ["agent:pr-open"]),
        ],
        records: new Map([
          [5, { approvedAt: "2026-11-11T09:00:00Z", assessment: bundleAssessment(5, [6, 7, 8, 99]) }],
          [6, { approvedAt: "2026-11-11T08:00:00Z", assessment: bundleAssessment(6, [5]) }],
        ]),
      }),
    );
    expect(actions).toEqual([
      { type: "implement", repo: "octo/app", issues: [5, 6, 7], approvedAt: "2026-11-11T08:00:00Z" },
    ]);
  });

  test("REQ-001-14 a Worktree whose PR is no longer open is cleaned up", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:pr-open"]), issue(10, [], { isPullRequest: true, author: { login: "bot", id: 1 } })],
        worktrees: [
          {
            issues: [5, 6],
            prNumber: 9,
            worktreePath: "/wt/5",
            reviewedHeadSha: null,
            feedbackRounds: 0,
            pendingFeedback: null,
            failedChecksSha: null,
            conflictSha: null,
            headSha: null,
            headSeenAt: null,
          },
          {
            issues: [7],
            prNumber: 10,
            worktreePath: "/wt/7",
            reviewedHeadSha: null,
            feedbackRounds: 0,
            pendingFeedback: null,
            failedChecksSha: null,
            conflictSha: null,
            headSha: null,
            headSeenAt: null,
          },
          {
            issues: [8],
            prNumber: null,
            worktreePath: "/wt/8",
            reviewedHeadSha: null,
            feedbackRounds: 0,
            pendingFeedback: null,
            failedChecksSha: null,
            conflictSha: null,
            headSha: null,
            headSeenAt: null,
          },
        ],
      }),
    );
    expect(actions).toEqual([
      { type: "cleanup", repo: "octo/app", issues: [5, 6], prNumber: 9, worktreePath: "/wt/5" },
    ]);
  });

  const pr = (n: number) => issue(n, [], { isPullRequest: true, author: { login: "bot", id: 1 } });
  const wt = (reviewedHeadSha: string | null = null, extra: Partial<WorktreeRecord> = {}): WorktreeRecord[] => [
    {
      issues: [5],
      prNumber: 9,
      worktreePath: "/wt/5",
      reviewedHeadSha,
      feedbackRounds: 0,
      pendingFeedback: null,
      failedChecksSha: null,
      conflictSha: null,
      headSha: null,
      headSeenAt: null,
      ...extra,
    },
  ];
  /** An hour before NOW_ISO: well past the checks grace period. */
  const SEEN = "2026-11-11T11:00:00.000Z";
  const pullOf = (headSha: string, checks: ChecksState, extra: Partial<Pull> = {}): Pull => ({
    headSha,
    checks,
    failed: [],
    mergeable: true,
    headSeenAt: SEEN,
    ...extra,
  });
  type Pull = NonNullable<Snapshot["pulls"]> extends ReadonlyMap<number, infer P> ? P : never;

  test("REQ-001-10 an agent PR whose head is unreviewed and whose checks passed (or has none) gets a Review", () => {
    for (const checks of ["success", "none"] as const) {
      const actions = deriveActions(
        snap({
          items: [issue(5, ["agent:pr-open"]), pr(9)],
          worktrees: wt(),
          pulls: new Map([[9, pullOf("h1", checks)]]),
        }),
      );
      expect(actions).toEqual([{ type: "review", repo: "octo/app", pr: 9, issues: [5], headSha: "h1" }]);
    }
  });

  test("REQ-001-10 no Review while checks are pending or failed, or when the head was already reviewed", () => {
    const items = [issue(5, ["agent:pr-open"]), pr(9)];
    for (const [checks, reviewed] of [
      ["pending", null],
      ["failure", null],
      ["success", "h1"],
    ] as const) {
      const actions = deriveActions(
        snap({ items, worktrees: wt(reviewed), pulls: new Map([[9, pullOf("h1", checks)]]) }),
      );
      expect(actions.filter((a) => a.type === "review")).toEqual([]);
    }
  });

  test("REQ-001-10 an idle Implementer session (kept for Feedback rounds) does not hold back the Review", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:pr-open"]), pr(9)],
        worktrees: wt(),
        pulls: new Map([[9, pullOf("h1", "success")]]),
        sessions: [session({ role: "implementer", issues: [5], state: "idle" })],
        liveSessionIds: new Set([1]),
      }),
    );
    expect(actions).toContainEqual(expect.objectContaining({ type: "review", pr: 9 }));
  });

  test("REQ-001-07 / REQ-001-10 no Review while the Implementer is running or a Reviewer session is open", () => {
    const items = [issue(5, ["agent:pr-open"]), pr(9)];
    const pulls = new Map([[9, pullOf("h1", "success")]]);
    for (const s of [
      session({ role: "implementer", issues: [5] }),
      session({ role: "reviewer", issues: [5], state: "idle" }),
    ]) {
      const actions = deriveActions(
        snap({ items, worktrees: wt(), pulls, sessions: [s], liveSessionIds: new Set([1]) }),
      );
      expect(actions.filter((a) => a.type === "review")).toEqual([]);
    }
  });

  const prItems = () => [issue(5, ["agent:pr-open"]), pr(9)];
  const passing = new Map([[9, pullOf("h2", "success")]]);
  const failing = new Map([[9, pullOf("h2", "failure", { failed: ["test: 2 failed"] })]]);
  const fb = (comments: { id: number; body: string }[], changesRequested: { id: number; body: string }[] = []) =>
    new Map([[9, { comments: comments.map((x) => c(x.id, x.body)), changesRequested }]]);

  test("REQ-001-11 blocking findings start a counted Feedback round", () => {
    const actions = deriveActions(
      snap({ items: prItems(), worktrees: wt("h2", { pendingFeedback: "Blocking: crash" }), pulls: passing }),
    );
    expect(actions).toEqual([
      {
        type: "feedback",
        repo: "octo/app",
        pr: 9,
        issues: [5],
        text: "Blocking: crash",
        counted: true,
        headSha: "h2",
        upToCommentId: 0,
        upToReviewId: 0,
        checksFailed: false,
        conflicted: false,
      },
    ]);
  });

  test("REQ-001-13 failing checks start a counted Feedback round with their output, once per head", () => {
    const actions = deriveActions(snap({ items: prItems(), worktrees: wt(), pulls: failing }));
    expect(actions).toEqual([
      expect.objectContaining({
        type: "feedback",
        counted: true,
        checksFailed: true,
        text: expect.stringContaining("test: 2 failed"),
      }),
    ]);
    expect(
      deriveActions(snap({ items: prItems(), worktrees: wt(null, { failedChecksSha: "h2" }), pulls: failing })),
    ).toEqual([]);
  });

  const conflicting = new Map([[9, pullOf("h2", "none", { mergeable: false, baseRef: "main" })]]);

  test("REQ-001-28 a PR with merge conflicts starts a counted Feedback round to merge the default branch, once per head", () => {
    expect(deriveActions(snap({ items: prItems(), worktrees: wt(), pulls: conflicting }))).toEqual([
      expect.objectContaining({
        type: "feedback",
        pr: 9,
        counted: true,
        conflicted: true,
        checksFailed: false,
        headSha: "h2",
        text: expect.stringContaining("git merge origin/main"),
      }),
    ]);
    expect(
      deriveActions(snap({ items: prItems(), worktrees: wt(null, { conflictSha: "h2" }), pulls: conflicting })),
    ).toEqual([]);
  });

  test("REQ-001-28 no Review while the PR has conflicts or GitHub is still computing whether it has", () => {
    for (const mergeable of [false, null]) {
      const pulls = new Map([[9, pullOf("h2", "success", { mergeable })]]);
      const actions = deriveActions(snap({ items: prItems(), worktrees: wt(null, { conflictSha: "h2" }), pulls }));
      expect(actions.filter((a) => a.type === "review")).toEqual([]);
    }
  });

  test("REQ-001-28 after maxFeedbackRounds a PR that still has conflicts is labelled agent:failed", () => {
    const actions = deriveActions(
      snap({ items: prItems(), worktrees: wt(null, { feedbackRounds: 2 }), pulls: conflicting, maxFeedbackRounds: 2 }),
    );
    expect(actions).toEqual([expect.objectContaining({ type: "fail", issues: [5], pr: 9 })]);
  });

  test("REQ-001-10 no checks count as passed only once the grace period since the head appeared is over", () => {
    const at = (headSeenAt: string) =>
      deriveActions(
        snap({
          items: prItems(),
          worktrees: wt(),
          pulls: new Map([[9, pullOf("h2", "none", { headSeenAt })]]),
          checksGraceSeconds: 120,
        }),
      ).filter((a) => a.type === "review");
    expect(at("2026-11-11T11:59:00.000Z")).toEqual([]);
    expect(at("2026-11-11T11:58:00.000Z")).toEqual([expect.objectContaining({ type: "review", headSha: "h2" })]);
  });

  test("REQ-001-11 after maxFeedbackRounds automatic rounds the PR is labelled agent:failed instead", () => {
    const actions = deriveActions(
      snap({
        items: prItems(),
        worktrees: wt("h2", { pendingFeedback: "x", feedbackRounds: 2 }),
        pulls: passing,
        maxFeedbackRounds: 2,
      }),
    );
    expect(actions).toEqual([
      {
        type: "fail",
        repo: "octo/app",
        issues: [5],
        pr: 9,
        reason: "the PR still had problems after 2 automatic Feedback rounds",
      },
    ]);
  });

  test("REQ-001-12 the Owner's /agent comment or changes-requested review starts an uncounted round, even past the limit", () => {
    const actions = deriveActions(
      snap({
        items: prItems(),
        worktrees: wt("h2", { pendingFeedback: "Blocking: crash", feedbackRounds: 2 }),
        pulls: passing,
        maxFeedbackRounds: 2,
        prFeedback: fb(
          [
            { id: 31, body: "/agent please also add docs" },
            { id: 32, body: "nice" },
          ],
          [{ id: 7, body: "Split the function" }],
        ),
      }),
    );
    expect(actions).toEqual([
      {
        type: "feedback",
        repo: "octo/app",
        pr: 9,
        issues: [5],
        text: "please also add docs\n\nSplit the function\n\nBlocking: crash",
        counted: false,
        headSha: "h2",
        upToCommentId: 32,
        upToReviewId: 7,
        checksFailed: false,
        conflicted: false,
      },
    ]);
  });

  test("REQ-001-10 / REQ-001-12 no Review of a head that a pending Feedback round is about to change", () => {
    const actions = deriveActions(
      snap({
        items: prItems(),
        worktrees: wt(null),
        pulls: passing,
        prFeedback: fb([{ id: 31, body: "/agent add docs" }]),
      }),
    );
    expect(actions.map((a) => a.type)).toEqual(["feedback"]);
  });

  test("REQ-001-24 /wake on an agent PR or an issue asks to wake its session", () => {
    expect(
      deriveActions(
        snap({ items: prItems(), worktrees: wt("h2"), pulls: passing, prFeedback: fb([{ id: 40, body: "/wake" }]) }),
      ),
    ).toEqual([{ type: "wake", repo: "octo/app", issue: 5, upToCommentId: 40, recordNumber: 9 }]);
    expect(
      deriveActions(
        snap({
          items: [issue(5, ["agent:pr-open"])],
          feedback: new Map([[5, { comments: [c(41, "/wake")], bodyChanged: false }]]),
        }),
      ),
    ).toEqual([{ type: "wake", repo: "octo/app", issue: 5, upToCommentId: 41, recordNumber: 5 }]);
  });

  test("REQ-001-01 ignores issues by anyone but the Owner, and PRs", () => {
    const actions = deriveActions(
      snap({
        items: [
          issue(1, [], { author: { login: "octo-impostor", id: 7 } }),
          issue(2, [], { author: { login: "octo", id: 7 } }),
          issue(3, [], { isPullRequest: true }),
        ],
      }),
    );
    expect(actions).toEqual([]);
  });

  test.each([
    ["agent:planning", "planner"],
    ["agent:in-progress", "implementer"],
    ["agent:reviewing", "reviewer"],
  ] as const)("REQ-001-07 starts nothing for an issue labelled %s while its %s session is live", (label, role) => {
    for (const state of ["running", "idle"] as const) {
      const actions = deriveActions(
        snap({
          items: [issue(5, [label])],
          sessions: [session({ role, issues: [5], state })],
          liveSessionIds: new Set([1]),
        }),
      );
      expect(actions).toEqual([]);
    }
  });

  test("REQ-001-07 finds a batch Planner session through any of its issues", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:planning"]), issue(6, ["agent:planning"])],
        sessions: [session({ role: "planner", kind: "batch", issues: [5, 6] })],
        liveSessionIds: new Set([1]),
      }),
    );
    expect(actions).toEqual([]);
  });

  test("REQ-001-16 resumes an interrupted session once after a restart", () => {
    const s = session({ role: "implementer", issues: [5] });
    const actions = deriveActions(snap({ items: [issue(5, ["agent:in-progress"])], sessions: [s] }));
    expect(actions).toEqual([{ type: "resume-interrupted", session: s }]);
  });

  test("REQ-001-16 labels the issue agent:failed when the interrupted session was already resumed once", () => {
    const s = session({ role: "implementer", issues: [5], resumeAttempts: 1 });
    const actions = deriveActions(snap({ items: [issue(5, ["agent:in-progress"])], sessions: [s] }));
    expect(actions).toEqual([
      {
        type: "fail",
        repo: "octo/app",
        issues: [5],
        session: s,
        reason: "session was interrupted again after being resumed once",
      },
    ]);
  });

  test("REQ-001-16 labels every issue of an interrupted batch agent:failed in one action", () => {
    const s = session({ role: "planner", kind: "batch", issues: [5, 6], resumeAttempts: 1 });
    const actions = deriveActions(
      snap({ items: [issue(5, ["agent:planning"]), issue(6, ["agent:planning"])], sessions: [s] }),
    );
    expect(actions).toEqual([
      {
        type: "fail",
        repo: "octo/app",
        issues: [5, 6],
        session: s,
        reason: "session was interrupted again after being resumed once",
      },
    ]);
  });

  test("REQ-001-16 labels the issue agent:failed when its in-flight label has no session to resume", () => {
    const actions = deriveActions(snap({ items: [issue(5, ["agent:reviewing"])] }));
    expect(actions).toEqual([{ type: "fail", repo: "octo/app", issues: [5], reason: "no reviewer session to resume" }]);
  });

  test("REQ-001-16 a session that was idle when the Coordinator stopped is just marked closed", () => {
    const s = session({ role: "implementer", issues: [5], state: "idle" });
    const actions = deriveActions(snap({ items: [issue(5, ["agent:pr-open"])], sessions: [s] }));
    expect(actions).toEqual([{ type: "mark-closed", session: s }]);
  });

  test("REQ-001-16 a session that never reported its id cannot be resumed", () => {
    const s = session({ role: "planner", issues: [5], claudeSessionId: null });
    const actions = deriveActions(snap({ items: [issue(5, ["agent:planning"])], sessions: [s] }));
    expect(actions).toEqual([
      {
        type: "fail",
        repo: "octo/app",
        issues: [5],
        session: s,
        reason: "session never reported its id, so it cannot be resumed",
      },
    ]);
  });
});
