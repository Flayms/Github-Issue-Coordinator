import { describe, expect, test } from "bun:test";
import type { ChecksState, Item } from "../src/github/client.ts";
import { type Action, deriveActions, issueState, type OpenPull, type Snapshot } from "../src/state.ts";
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
  startedAt: null,
  account: null,
  claudeSessionId: "sess-1",
  state: "running",
  resumeAttempts: 0,
  lastActivityAt: "2026-11-10T00:00:00Z",
  ownerMessagedAt: null,
  coordinatorPromptPending: false,
  resultFailures: 0,
  needsSync: false,
  usageLimited: false,
  usageLimitResetsAt: null,
  modelId: null,
  title: null,
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
  test("REQ-001-16 no agent label means new; the most advanced agent label wins", () => {
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
        blockers: [],
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
      { type: "approve", repo: "octo/app", issue: 5, notes: "", at: NOW_ISO, upToCommentId: 0, blockers: [] },
    ]);
  });

  test("REQ-001-05 an approval names the issue's open blockers, so it can go straight to agent:blocked", () => {
    const records = new Map([[5, { approvedAt: null, assessment: assessment([8, 99]) }]]);
    const byComment = deriveActions(
      snap({
        items: [issue(5, ["agent:proposed"]), issue(8, ["agent:proposed"])],
        records,
        feedback: new Map([[5, { comments: [c(22, "/approve")], bodyChanged: false }]]),
      }),
    );
    expect(byComment).toContainEqual(expect.objectContaining({ type: "approve", issue: 5, blockers: [8] }));
    const byLabel = deriveActions(
      snap({
        items: [issue(5, ["agent:proposed", "agent:approved"]), issue(8, ["agent:proposed"])],
        records,
        labelActors: new Map([[5, OWNER]]),
      }),
    );
    expect(byLabel).toContainEqual(expect.objectContaining({ type: "approve", issue: 5, blockers: [8] }));
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

  describe("REQ-001-59 a Bundle waits while the Owner is still discussing one of its issues", () => {
    const records = new Map([[5, { approvedAt: "2026-11-11T09:00:00Z", assessment: bundleAssessment(5, [7]) }]]);
    const implement = expect.objectContaining({ type: "implement" });
    const note = (id: number, body: string, author = OWNER) => ({ id, body, author, createdAt: "", updatedAt: "" });

    test("waits while a bundled proposal has an unanswered Owner comment or an edited description, and revises it", () => {
      const items = [issue(5, ["agent:approved"]), issue(7, ["agent:proposed"])];
      const comment = deriveActions(
        snap({ items, records, feedback: new Map([[7, { comments: [note(70, "add images")], bodyChanged: false }]]) }),
      );
      expect(comment).not.toContainEqual(implement);
      expect(comment).toContainEqual(expect.objectContaining({ type: "revise", issue: 7 }));
      const edited = deriveActions(
        snap({ items, records, feedback: new Map([[7, { comments: [], bodyChanged: true }]]) }),
      );
      expect(edited).not.toContainEqual(implement);
    });

    test("waits while a bundled issue is being planned", () => {
      const items = [issue(5, ["agent:approved"]), issue(7, ["agent:planning"])];
      const sessions = [session({ role: "planner", issues: [7] })];
      expect(deriveActions(snap({ items, records, sessions, liveSessionIds: new Set([1]) }))).not.toContainEqual(
        implement,
      );
    });

    test("a proposal with only someone else's comment or a command still joins; other states start without it", () => {
      const items = [issue(5, ["agent:approved"]), issue(7, ["agent:proposed"])];
      const feedback = new Map([
        [7, { comments: [note(71, "me too", { login: "x", id: 1 }), note(72, "/wake")], bodyChanged: false }],
      ]);
      expect(deriveActions(snap({ items, records, feedback }))).toContainEqual(
        expect.objectContaining({ type: "implement", issues: [5, 7] }),
      );
      const refining = [issue(5, ["agent:approved"]), issue(7, ["agent:needs-refinement"])];
      expect(deriveActions(snap({ items: refining, records }))).toContainEqual(
        expect.objectContaining({ type: "implement", issues: [5] }),
      );
    });
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
      readySha: null,
      conflictSha: null,
      reviewRisk: null,
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
    state: "open",
    ...extra,
  });
  type Pull = NonNullable<Snapshot["pulls"]> extends ReadonlyMap<number, infer P> ? P : never;

  test("REQ-001-14 / REQ-003-33 a Worktree is cleaned up once GitHub reports its PR merged or closed, saying which", () => {
    const worktrees = [
      ...wt(null, { issues: [5, 6], prNumber: 9, worktreePath: "/wt/5" }),
      ...wt(null, { issues: [7], prNumber: 10, worktreePath: "/wt/7" }),
      ...wt(null, { issues: [8], prNumber: null, worktreePath: "/wt/8" }),
    ];
    const actions = deriveActions(
      snap({
        // PR #10 is still in the (stale) list; what counts is the PR's own state.
        items: [issue(5, ["agent:pr-open"]), pr(10)],
        worktrees,
        pulls: new Map([
          [9, pullOf("h1", "pending", { state: "merged" })],
          [10, pullOf("h1", "pending", { state: "closed" })],
        ]),
      }),
    );
    expect(actions).toEqual([
      { type: "cleanup", repo: "octo/app", issues: [5, 6], prNumber: 9, worktreePath: "/wt/5", merged: true },
      { type: "cleanup", repo: "octo/app", issues: [7], prNumber: 10, worktreePath: "/wt/7", merged: false },
    ]);
  });

  test("REQ-001-14 a PR missing from the open list but open on GitHub keeps its Worktree and gets a Review", () => {
    const actions = deriveActions(
      snap({ items: [issue(5, ["agent:pr-open"])], worktrees: wt(), pulls: new Map([[9, pullOf("h1", "success")]]) }),
    );
    expect(actions).toEqual([{ type: "review", repo: "octo/app", pr: 9, issues: [5], headSha: "h1" }]);
  });

  test("REQ-001-14 a PR missing from the open list but open on GitHub still gets Feedback rounds", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:pr-open"])],
        worktrees: wt(),
        pulls: new Map([[9, pullOf("h2", "pending", { mergeable: false })]]),
      }),
    );
    expect(actions).toEqual([expect.objectContaining({ type: "feedback", pr: 9, conflicted: true })]);
  });

  test("REQ-001-14 a PR whose state could not be fetched is neither cleaned up nor reviewed", () => {
    expect(deriveActions(snap({ items: [issue(5, ["agent:pr-open"])], worktrees: wt(), pulls: new Map() }))).toEqual(
      [],
    );
  });

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

  test("REQ-001-10 a Review runs right away, whether the head's checks are pending, passed or failed", () => {
    const items = [issue(5, ["agent:pr-open"]), pr(9)];
    for (const checks of ["pending", "failure", "success"] as const) {
      const actions = deriveActions(snap({ items, worktrees: wt(), pulls: new Map([[9, pullOf("h1", checks)]]) }));
      expect(actions).toEqual([{ type: "review", repo: "octo/app", pr: 9, issues: [5], headSha: "h1" }]);
    }
  });

  test("REQ-001-10 a head without checks right after the push is reviewed without waiting for the grace period", () => {
    const pulls = new Map([[9, pullOf("h1", "none", { headSeenAt: NOW_ISO })]]);
    const actions = deriveActions(
      snap({ items: [issue(5, ["agent:pr-open"]), pr(9)], worktrees: wt(), pulls, checksGraceSeconds: 120 }),
    );
    expect(actions).toEqual([expect.objectContaining({ type: "review", headSha: "h1" })]);
  });

  test("REQ-001-10 no Review when the head was already reviewed", () => {
    const items = [issue(5, ["agent:pr-open"]), pr(9)];
    const actions = deriveActions(snap({ items, worktrees: wt("h1"), pulls: new Map([[9, pullOf("h1", "success")]]) }));
    expect(actions.filter((a) => a.type === "review")).toEqual([]);
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

  test("REQ-001-11 Review findings start a counted Feedback round", () => {
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
        causes: ["findings"],
        headSha: "h2",
        upToCommentId: 0,
        upToReviewId: 0,
        checksFailed: false,
        conflicted: false,
      },
    ]);
  });

  test("REQ-001-13 failing checks start a counted Feedback round with their output, once per head", () => {
    const actions = deriveActions(snap({ items: prItems(), worktrees: wt("h2"), pulls: failing }));
    expect(actions).toEqual([
      expect.objectContaining({
        type: "feedback",
        counted: true,
        causes: ["checks"],
        checksFailed: true,
        text: expect.stringContaining("test: 2 failed"),
      }),
    ]);
    expect(
      deriveActions(snap({ items: prItems(), worktrees: wt("h2", { failedChecksSha: "h2" }), pulls: failing })),
    ).toEqual([]);
  });

  describe("REQ-001-64 checks and findings share one Feedback round", () => {
    test("failing checks of a head that is still to be reviewed wait for its Review instead of starting a round", () => {
      const actions = deriveActions(snap({ items: prItems(), worktrees: wt(), pulls: failing }));
      expect(actions).toEqual([{ type: "review", repo: "octo/app", pr: 9, issues: [5], headSha: "h2" }]);
    });

    test("failing checks start no round while the head's Review runs", () => {
      const actions = deriveActions(
        snap({
          items: [issue(5, ["agent:reviewing"]), pr(9)],
          worktrees: wt(),
          pulls: failing,
          sessions: [session({ role: "reviewer", issues: [5] })],
          liveSessionIds: new Set([1]),
        }),
      );
      expect(actions).toEqual([]);
    });

    test("once the Review is posted, its findings and the failing checks go to one round, counted once", () => {
      const actions = deriveActions(
        snap({ items: prItems(), worktrees: wt("h2", { pendingFeedback: "Review findings: crash" }), pulls: failing }),
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: "feedback",
          counted: true,
          causes: ["findings", "checks"],
          checksFailed: true,
          text: expect.stringMatching(/^Review findings: crash\n\nFailing checks on h2:\n\n- test: 2 failed$/),
        }),
      ]);
      expect(actions.filter((a) => a.type === "feedback")).toHaveLength(1);
    });

    test("checks that fail after a Review without findings start a checks round", () => {
      const actions = deriveActions(
        snap({ items: [issue(5, ["agent:reviewed"]), pr(9)], worktrees: wt("h2"), pulls: failing }),
      );
      expect(actions).toEqual([expect.objectContaining({ type: "feedback", causes: ["checks"], counted: true })]);
    });
  });

  describe("REQ-001-31 / REQ-001-64 a PR leaves draft once its head has a Review without findings and passing checks", () => {
    const reviewed = (
      checks: ChecksState,
      extra: Partial<Pull> = {},
      w: Partial<WorktreeRecord> = {},
      label = "agent:reviewed",
    ) =>
      deriveActions(
        snap({
          items: [issue(5, [label]), pr(9)],
          worktrees: wt("h2", w),
          pulls: new Map([[9, pullOf("h2", checks, { draft: true, ...extra })]]),
          checksGraceSeconds: 120,
        }),
      );

    test("a draft whose reviewed head's checks passed is marked ready", () => {
      expect(reviewed("success")).toEqual([{ type: "ready", repo: "octo/app", pr: 9, issues: [5], headSha: "h2" }]);
    });

    test("no checks count as passed once the grace period since the head appeared is over", () => {
      expect(reviewed("none", { headSeenAt: "2026-11-11T11:59:00.000Z" })).toEqual([]);
      expect(reviewed("none", { headSeenAt: "2026-11-11T11:58:00.000Z" })).toEqual([
        expect.objectContaining({ type: "ready", headSha: "h2" }),
      ]);
    });

    test("not while its checks are pending or failed", () => {
      expect(reviewed("pending")).toEqual([]);
      expect(reviewed("failure", { failed: ["lint"] }).filter((a) => a.type === "ready")).toEqual([]);
    });

    test("only once per head, only for a draft, and not for a head whose findings were declined", () => {
      expect(reviewed("success", {}, { readySha: "h2" })).toEqual([]); // e.g. the Owner turned it back into a draft
      expect(reviewed("success", { draft: false })).toEqual([]);
      expect(reviewed("success", {}, {}, "agent:pr-open")).toEqual([]); // REQ-001-31: waits for the Owner
    });

    test("not while a round is due on the PR", () => {
      expect(reviewed("success", {}, { pendingFeedback: "x" }).filter((a) => a.type === "ready")).toEqual([]);
    });
  });

  describe("REQ-001-65 auto-merge mode: a PR that would leave draft is merged when the mode allows its Risk tier", () => {
    const at = (
      autoMerge: Snapshot["autoMerge"],
      reviewRisk: WorktreeRecord["reviewRisk"],
      o: {
        checks?: ChecksState;
        pull?: Partial<Pull>;
        w?: Partial<WorktreeRecord>;
        label?: string;
        s?: Partial<Snapshot>;
      } = {},
    ) =>
      deriveActions(
        snap({
          items: [issue(5, [o.label ?? "agent:reviewed"]), pr(9)],
          worktrees: wt("h2", { reviewRisk, ...o.w }),
          pulls: new Map([[9, pullOf("h2", o.checks ?? "success", { draft: true, ...o.pull })]]),
          checksGraceSeconds: 120,
          autoMerge,
          ...o.s,
        }),
      );
    const ready: Action = { type: "ready", repo: "octo/app", pr: 9, issues: [5], headSha: "h2" };
    const merge = (mode: "evaluated" | "all", risk: WorktreeRecord["reviewRisk"]): Action => ({
      type: "merge",
      repo: "octo/app",
      pr: 9,
      issues: [5],
      headSha: "h2",
      mode,
      risk,
    });

    test("off marks every tier ready for the Owner", () => {
      for (const risk of ["low", "medium", "high", null] as const) expect(at("off", risk)).toEqual([ready]);
    });

    test("evaluated (and no mode at all, the default) merges a low tier only; medium, high or no tier on record go to the Owner", () => {
      for (const mode of ["evaluated", undefined] as const) {
        expect(at(mode, "low")).toEqual([merge("evaluated", "low")]);
        for (const risk of ["medium", "high", null] as const) expect(at(mode, risk)).toEqual([ready]);
      }
    });

    test("all merges every tier", () => {
      for (const risk of ["low", "medium", "high", null] as const)
        expect(at("all", risk)).toEqual([merge("all", risk)]);
    });

    test("all never skips a gate: findings, declined findings, a failed issue, pending or failed checks, the grace period", () => {
      const merges = (actions: ReturnType<typeof at>) =>
        actions.filter((a) => a.type === "merge" || a.type === "ready");
      expect(merges(at("all", "low", { w: { pendingFeedback: "1. fix" } }))).toEqual([]);
      expect(merges(at("all", "low", { label: "agent:pr-open" }))).toEqual([]); // findings declined
      expect(merges(at("all", "low", { label: "agent:failed" }))).toEqual([]);
      expect(merges(at("all", "low", { checks: "pending" }))).toEqual([]);
      expect(merges(at("all", "low", { checks: "failure", pull: { failed: ["lint"] } }))).toEqual([]);
      expect(merges(at("all", "low", { checks: "none", pull: { headSeenAt: "2026-11-11T11:59:00.000Z" } }))).toEqual(
        [],
      );
      expect(merges(at("all", "low", { w: { readySha: "h2" } }))).toEqual([]); // once per head
      expect(merges(at("all", "low", { w: { reviewedHeadSha: "h1" } }))).toEqual([]); // a newer head, not reviewed
    });

    test("all waits for a pending /agent comment or changes requested by the Owner", () => {
      const own = { author: OWNER, createdAt: NOW_ISO, updatedAt: NOW_ISO };
      const agent = new Map([[9, { comments: [{ id: 1, body: "/agent rename it", ...own }], changesRequested: [] }]]);
      expect(at("all", "low", { s: { prFeedback: agent } }).map((a) => a.type)).toEqual(["feedback"]);
      const changes = new Map([[9, { comments: [], changesRequested: [{ id: 3, body: "No" }] }]]);
      expect(at("all", "low", { s: { prFeedback: changes } }).map((a) => a.type)).toEqual(["feedback"]);
    });

    test("a conflicted PR is never merged: a new conflict starts its round, a known one goes to the Owner", () => {
      expect(at("all", "low", { pull: { mergeable: false } }).map((a) => a.type)).toEqual(["feedback"]);
      expect(at("all", "low", { pull: { mergeable: false }, w: { conflictSha: "h2" } })).toEqual([ready]);
    });

    test("while GitHub is still computing whether it can be merged, it waits", () => {
      expect(at("all", "low", { pull: { mergeable: null } })).toEqual([]);
    });
  });

  const conflicting = new Map([[9, pullOf("h2", "none", { mergeable: false, baseRef: "main" })]]);

  test("REQ-001-28 a PR with merge conflicts starts an uncounted Feedback round to merge the default branch, once per head", () => {
    expect(deriveActions(snap({ items: prItems(), worktrees: wt(), pulls: conflicting }))).toEqual([
      expect.objectContaining({
        type: "feedback",
        pr: 9,
        counted: false,
        causes: ["conflicts"],
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

  test("REQ-001-28 a PR that conflicts after maxFeedbackRounds still gets its merge round", () => {
    const actions = deriveActions(
      snap({ items: prItems(), worktrees: wt("h1", { feedbackRounds: 2 }), pulls: conflicting, maxFeedbackRounds: 2 }),
    );
    expect(actions).toEqual([expect.objectContaining({ type: "feedback", counted: false, conflicted: true })]);
  });

  test("REQ-001-28 no automatic round on a PR whose issue is labelled agent:failed", () => {
    const items = [issue(5, ["agent:failed"]), pr(9)];
    for (const extra of [{ pendingFeedback: "x" }, {}]) {
      const actions = deriveActions(snap({ items, worktrees: wt(null, extra), pulls: conflicting }));
      expect(actions).toEqual([]);
    }
  });

  test("REQ-001-37 the Owner's round on a conflicting PR fetches the default branch and asks for the merge, also once it failed", () => {
    for (const labels of [["agent:pr-open"], ["agent:failed"]]) {
      const actions = deriveActions(
        snap({
          items: [issue(5, labels), pr(9)],
          worktrees: wt("h1", { conflictSha: "h2", feedbackRounds: 2 }),
          pulls: conflicting,
          maxFeedbackRounds: 2,
          prFeedback: fb([{ id: 31, body: "/agent fix the conflicts" }]),
        }),
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: "feedback",
          counted: false,
          causes: [],
          conflicted: true,
          text: expect.stringMatching(/^fix the conflicts\n\n.*git merge origin\/main/s),
        }),
      ]);
    }
  });

  test("REQ-001-38 an automatic round names its causes, so a round without new commits can say why it stalled", () => {
    const pulls = new Map([[9, pullOf("h2", "failure", { failed: ["lint"] })]]);
    const actions = deriveActions(snap({ items: prItems(), worktrees: wt(null, { pendingFeedback: "x" }), pulls }));
    expect(actions).toEqual([expect.objectContaining({ type: "feedback", causes: ["findings", "checks"] })]);
  });

  test("REQ-001-13 / REQ-001-28 giving up past the limit names the head, so it happens once per head", () => {
    const pulls = new Map([[9, pullOf("h2", "failure", { mergeable: false, failed: ["lint"] })]]);
    const actions = deriveActions(
      snap({ items: prItems(), worktrees: wt(null, { feedbackRounds: 2 }), pulls, maxFeedbackRounds: 2 }),
    );
    expect(actions).toEqual([
      expect.objectContaining({ type: "fail", pr: 9, headSha: "h2", checksFailed: true, conflicted: true }),
    ]);
  });

  test("REQ-001-31 after a round that declined the findings without new commits, the reviewed head waits for the Owner", () => {
    const actions = deriveActions(
      snap({ items: prItems(), worktrees: wt("h2", { feedbackRounds: 1 }), pulls: passing }),
    );
    expect(actions).toEqual([]);
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
        headSha: "h2",
        checksFailed: false,
        conflicted: false,
      },
    ]);
  });

  test("REQ-001-39 an agent:in-progress issue with Review findings on record and no Implementer session gets its round, not agent:failed", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:in-progress"]), pr(9)],
        worktrees: wt("h2", { pendingFeedback: "Blocking: crash" }),
        pulls: passing,
      }),
    );
    expect(actions).toEqual([expect.objectContaining({ type: "feedback", pr: 9, issues: [5], counted: true })]);
  });

  test("REQ-001-39 / REQ-001-11 past maxFeedbackRounds such an issue fails once, for the round limit", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:in-progress"]), pr(9)],
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
        headSha: "h2",
        checksFailed: false,
        conflicted: false,
        reason: "the PR still had problems after 2 automatic Feedback rounds",
      },
    ]);
  });

  test("REQ-001-07 / REQ-001-39 an agent:in-progress issue without Review findings on record and no session still fails", () => {
    const actions = deriveActions(
      snap({ items: [issue(5, ["agent:in-progress"]), pr(9)], worktrees: wt("h2"), pulls: passing }),
    );
    expect(actions).toEqual([
      { type: "fail", repo: "octo/app", issues: [5], reason: "no implementer session to resume" },
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
        causes: [],
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

  test("REQ-001-01 / REQ-001-34 a Split-off issue on record is in scope like an Owner issue; other bot issues are not", () => {
    const bot = { login: "coordinator[bot]", id: 900 };
    const actions = deriveActions(
      snap({
        items: [issue(31, [], { author: bot }), issue(32, [], { author: bot })],
        splitOffs: new Set([31]),
      }),
    );
    expect(actions).toEqual([{ type: "plan", repo: "octo/app", issues: [31] }]);
  });

  test("REQ-001-04 / REQ-001-34 on a Split-off issue only the Owner's comments count", () => {
    const bot = { login: "coordinator[bot]", id: 900 };
    const foreign = { id: 1, body: "/approve", author: bot, createdAt: "c", updatedAt: "c" };
    const actions = deriveActions(
      snap({
        items: [issue(31, ["agent:proposed"], { author: bot })],
        splitOffs: new Set([31]),
        feedback: new Map([[31, { comments: [foreign], bodyChanged: false }]]),
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

  test("REQ-001-16 a session that exited before Claude Code started cannot be resumed", () => {
    const s = session({ role: "planner", issues: [5], claudeSessionId: null });
    const actions = deriveActions(snap({ items: [issue(5, ["agent:planning"])], sessions: [s] }));
    expect(actions).toEqual([
      {
        type: "fail",
        repo: "octo/app",
        issues: [5],
        session: s,
        reason: "the session exited before Claude Code started",
      },
    ]);
  });
});

describe("agent PRs without a Worktree on record", () => {
  const openPull = (number: number, headRef: string, extra: Partial<OpenPull> = {}): OpenPull => ({
    number,
    headRef,
    headRepo: "octo/app",
    body: "",
    ...extra,
  });
  const approvedRecord = new Map([
    [
      5,
      {
        approvedAt: "2026-11-11T09:00:00Z",
        assessment: JSON.stringify({ issue: 5, verdict: "proposed", approach: "A", bundleWith: [], blockedBy: [] }),
      },
    ],
  ]);
  const record: WorktreeRecord = {
    issues: [5],
    prNumber: 34,
    worktreePath: "/wt/5",
    reviewedHeadSha: null,
    feedbackRounds: 0,
    pendingFeedback: null,
    failedChecksSha: null,
    readySha: null,
    conflictSha: null,
    reviewRisk: null,
    headSha: null,
    headSeenAt: null,
  };

  test("REQ-001-42 a new issue with an open agent PR named after it is not planned", () => {
    const actions = deriveActions(
      snap({ items: [issue(5), issue(6)], openPulls: [openPull(34, "agent/5-fix-it")], worktrees: [record] }),
    );
    expect(actions).toEqual([{ type: "plan", repo: "octo/app", issues: [6] }]);
  });

  test("REQ-001-42 an issue an agent PR closes is not planned, whatever the branch number", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5), issue(6), issue(7)],
        openPulls: [openPull(34, "agent/5-bundle", { body: "note\n\nCloses #5\ncloses #6\nFixes: #99" })],
        worktrees: [{ ...record, issues: [5, 6] }],
      }),
    );
    expect(actions).toEqual([{ type: "plan", repo: "octo/app", issues: [7] }]);
  });

  test("REQ-001-42 an approved issue with an open agent PR starts no Implementer, nor joins a Bundle", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:approved"]), issue(6, ["agent:approved"])],
        records: new Map([
          ...approvedRecord,
          [
            6,
            {
              approvedAt: "2026-11-11T10:00:00Z",
              assessment: JSON.stringify({ issue: 6, verdict: "proposed", approach: "A", bundleWith: [5] }),
            },
          ],
        ]),
        openPulls: [openPull(34, "agent/5-fix-it")],
        worktrees: [record],
      }),
    );
    expect(actions).toEqual([{ type: "implement", repo: "octo/app", issues: [6], approvedAt: "2026-11-11T10:00:00Z" }]);
  });

  test("REQ-001-42 a PR from a fork, or from a branch not named agent/<n>-…, is not an agent PR", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5), issue(6)],
        openPulls: [
          openPull(34, "agent/5-fix-it", { headRepo: "mallory/app", body: "Closes #6" }),
          openPull(35, "agent/5-fix-it", { headRepo: null }),
          openPull(36, "feature/6", { body: "Closes #6" }),
          openPull(37, "agent/x-5", { body: "" }),
        ],
      }),
    );
    expect(actions).toEqual([{ type: "plan", repo: "octo/app", issues: [5, 6] }]);
  });

  test("REQ-001-43 an open agent PR with no Worktree on record is re-attached, for its open issues in scope", () => {
    const actions = deriveActions(
      snap({
        items: [issue(5, ["agent:proposed"]), issue(7, [], { author: { login: "mallory", id: 666 } })],
        openPulls: [openPull(34, "agent/5-fix-it", { body: "Closes #5\nCloses #6\nCloses #7" })],
      }),
    );
    expect(actions).toEqual([{ type: "reattach", repo: "octo/app", pr: 34, branch: "agent/5-fix-it", issues: [5] }]);
  });

  test("REQ-001-43 an issue being re-attached with a stale in-flight label and no session is not failed", () => {
    for (const label of ["agent:planning", "agent:in-progress", "agent:reviewing"]) {
      const actions = deriveActions(snap({ items: [issue(5, [label])], openPulls: [openPull(34, "agent/5-fix-it")] }));
      expect(actions).toEqual([{ type: "reattach", repo: "octo/app", pr: 34, branch: "agent/5-fix-it", issues: [5] }]);
    }
  });

  test("REQ-001-43 a PR whose issues have a Worktree on record is not re-attached", () => {
    for (const w of [record, { ...record, prNumber: null }, { ...record, issues: [6], prNumber: 34 }]) {
      const actions = deriveActions(
        snap({
          items: [issue(5, ["agent:pr-open"]), issue(6, ["agent:pr-open"])],
          openPulls: [openPull(34, "agent/5-fix-it", { body: "Closes #5" })],
          worktrees: [w],
        }),
      );
      expect(actions.filter((a) => a.type === "reattach")).toEqual([]);
    }
  });

  test("REQ-001-43 a PR whose issue has an open session, or one still to be synced, is not re-attached", () => {
    for (const s of [
      {
        sessions: [session({ role: "planner", kind: "batch", issues: [4, 5], state: "idle" })],
        liveSessionIds: new Set([1]),
      },
      { pendingSync: [session({ role: "implementer", issues: [5], state: "closed" })] },
    ]) {
      const actions = deriveActions(
        snap({ items: [issue(5, ["agent:proposed"])], openPulls: [openPull(34, "agent/5-fix-it")], ...s }),
      );
      expect(actions.filter((a) => a.type === "reattach")).toEqual([]);
    }
  });

  test("REQ-001-43 an orphaned agent PR whose issues are all closed or out of scope is only reported", () => {
    const actions = deriveActions(
      snap({
        items: [issue(7, [], { author: { login: "mallory", id: 666 } })],
        openPulls: [openPull(34, "agent/5-fix-it", { body: "Closes #7" })],
      }),
    );
    expect(actions).toEqual([{ type: "orphan-closed", repo: "octo/app", pr: 34, issues: [5, 7] }]);
  });
});
