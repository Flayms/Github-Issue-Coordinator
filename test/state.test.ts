import { describe, expect, test } from "bun:test";
import type { Item } from "../src/github/client.ts";
import { deriveActions, issueState, type Snapshot } from "../src/state.ts";
import type { SessionRecord } from "../src/store.ts";

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
    expect(actions).toEqual([
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
