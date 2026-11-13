import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { Coordinator, USAGE_LIMIT_PAUSE_MIN } from "../src/coordinator.ts";
import type { Comment, Item } from "../src/github/client.ts";
import type { StartOptions } from "../src/runner.ts";
import { Store } from "../src/store.ts";

const OWNER = { login: "octo", id: 42 };
const config = parseConfig({
  owner: OWNER,
  github: { appId: 7, privateKeyPath: "/k.pem" },
  roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app" }],
});

const item = (number: number, labels: string[] = [], extra: Partial<Item> = {}): Item => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  author: OWNER,
  labels,
  isPullRequest: false,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  ...extra,
});

class FakeGitHub {
  items: Item[] = [];
  labelActorOf = new Map<number, { login: string; id: number }>();
  async labelActor(_r: string, issue: number) {
    return this.labelActorOf.get(issue);
  }
  comments = new Map<number, Comment[]>();
  changed = true;
  calls: unknown[][] = [];
  commentFetches = 0;
  async listOpenItems() {
    const changed = this.changed;
    this.changed = false;
    return { changed, items: this.items };
  }
  async listComments(_repo: string, issue: number, opts: { afterId?: number } = {}) {
    this.commentFetches++;
    return (this.comments.get(issue) ?? []).filter((c) => c.id > (opts.afterId ?? 0));
  }
  async addLabels(_r: string, issue: number, labels: string[]) {
    this.calls.push(["addLabels", issue, labels]);
    const i = this.items.find((x) => x.number === issue);
    if (i) i.labels = [...new Set([...i.labels, ...labels])];
    this.changed = true;
  }
  async removeLabel(_r: string, issue: number, label: string) {
    this.calls.push(["removeLabel", issue, label]);
    const i = this.items.find((x) => x.number === issue);
    if (i) i.labels = i.labels.filter((l) => l !== label);
    this.changed = true;
  }
  async createComment(_r: string, issue: number, body: string) {
    this.calls.push(["createComment", issue, body]);
    return 500 + this.calls.length;
  }
  async updateComment(_r: string, id: number, body: string) {
    this.calls.push(["updateComment", id, body]);
  }
  /** How many createPull calls fail before one succeeds (REQ-001-27). */
  createPullFailures = 0;
  async createPull(_r: string, pr: { title: string; body: string; head: string; base: string }) {
    if (this.createPullFailures > 0) {
      this.createPullFailures--;
      throw new Error("GitHub POST /repos/octo/app/pulls failed with 403: Resource not accessible by integration");
    }
    this.calls.push(["createPull", pr.title]);
    return 70;
  }
  async updatePull(_r: string, pr: number) {
    this.calls.push(["updatePull", pr]);
  }
  heads = new Map<number, string>();
  checkState: "none" | "pending" | "success" | "failure" = "success";
  async getPull(_r: string, pr: number) {
    return { number: pr, headSha: this.heads.get(pr) ?? "h1", headRef: "agent/5-x", baseRef: "main" };
  }
  async checks() {
    return { state: this.checkState, failed: this.checkState === "failure" ? ["test"] : [] };
  }
  async createReview(_r: string, pr: number, review: { commitId: string }) {
    this.calls.push(["createReview", pr, review.commitId]);
  }
  reviews = new Map<number, { id: number; state: string; body: string; author: { login: string; id: number } }[]>();
  async listReviews(_r: string, pr: number) {
    return this.reviews.get(pr) ?? [];
  }
}

class FakeWorktrees {
  removed: string[] = [];
  hasRoom() {
    return true;
  }
  async create(_repo: string, issues: number[]) {
    return { path: `/wt/${issues[0]}`, branch: `agent/${issues[0]}-x` };
  }
  async push() {}
  commitsAhead() {
    return 1;
  }
  currentBranch() {
    return "agent/5-x";
  }
  defaultBranch() {
    return "main";
  }
  remove(path: string) {
    this.removed.push(path);
  }
  async reviewCheckout(_repo: string, pr: number) {
    return `/reviews/${pr}`;
  }
  reviewPath(_repo: string, pr: number) {
    return `/reviews/${pr}`;
  }
  head() {
    return "h1";
  }
}

/** Behaves like the real runner on top of the store, with "windows" as a set. */
class FakeRunner {
  live = new Set<number>();
  started: StartOptions[] = [];
  resumed: [number, string][] = [];
  closed: number[] = [];
  constructor(
    private store: Store,
    private dir: string,
  ) {}
  start(o: StartOptions) {
    this.started.push(o);
    const id = this.store.createSession({ repo: o.repo, role: o.role, kind: o.kind, issues: o.issues });
    this.store.setClaudeSessionId(id, `claude-${id}`);
    mkdirSync(this.sessionDir(id), { recursive: true });
    this.live.add(id);
    return id;
  }
  kept: number[] = [];
  resume(id: number, prompt: string, _model?: unknown, opts: { keepResult?: boolean } = {}) {
    this.resumed.push([id, prompt]);
    if (opts.keepResult) this.kept.push(id);
    this.store.patchSession(id, { state: "running", usageLimited: false });
    this.live.add(id);
  }
  close(id: number) {
    this.closed.push(id);
    this.live.delete(id);
    this.store.patchSession(id, { state: "closed" });
  }
  sessionDir(id: number) {
    return join(this.dir, "sessions", String(id));
  }
  liveSessionIds() {
    return new Set(this.live);
  }
  answerDialogs() {}
}

let dir: string;
let now: Date;
let store: Store;
let gh: FakeGitHub;
let runner: FakeRunner;
let worktrees: FakeWorktrees;
let coordinator: Coordinator;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coord-"));
  now = new Date("2026-11-11T10:00:00Z");
  store = new Store(":memory:", () => now);
  gh = new FakeGitHub();
  runner = new FakeRunner(store, dir);
  worktrees = new FakeWorktrees();
  coordinator = new Coordinator({
    config,
    store,
    gh,
    runner,
    worktrees,
    clones: { mainClone: async (repo: string) => `/clones/${repo}` },
    now: () => now,
    log: () => {},
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true });
});

const finishPlanner = (id: number, issues: number[], verdict = "proposed") => {
  const result = issues.map((issue) => ({
    issue,
    verdict,
    approach: `A${issue}`,
    bundleWith: [],
    blockedBy: [],
    questions: [],
  }));
  writeFileSync(join(runner.sessionDir(id), "result.json"), JSON.stringify(result));
  store.patchSession(id, { state: "idle", needsSync: true });
};

describe("reconcile loop", () => {
  test("REQ-001-02 / REQ-001-07 plans new Owner issues once, in the main clone, and syncs the Assessments", async () => {
    gh.items = [item(5), item(6), item(7, [], { author: { login: "mallory", id: 666 } })];
    await coordinator.tick();
    expect(runner.started).toEqual([
      expect.objectContaining({ kind: "batch", issues: [5, 6], cwd: "/clones/octo/app" }),
    ]);

    await coordinator.tick();
    expect(runner.started).toHaveLength(1);

    finishPlanner(1, [5, 6]);
    await coordinator.tick();
    expect(gh.items.map((i) => i.labels)).toEqual([["agent:proposed"], ["agent:proposed"], []]);
    expect(runner.closed).toEqual([1]);
    expect(runner.started).toHaveLength(1);
  });

  test("REQ-001-03 an Owner comment on a proposal revises the plan; other people's comments are ignored", async () => {
    gh.items = [item(5)];
    await coordinator.tick();
    finishPlanner(1, [5]);
    await coordinator.tick();

    gh.comments.set(5, [
      { id: 900, body: "spam", author: { login: "mallory", id: 666 }, createdAt: "", updatedAt: "" },
    ]);
    gh.changed = true;
    await coordinator.tick();
    expect(runner.started).toHaveLength(1);

    gh.comments.set(5, [
      ...(gh.comments.get(5) ?? []),
      { id: 901, body: "Use v2", author: OWNER, createdAt: "", updatedAt: "" },
    ]);
    gh.changed = true;
    await coordinator.tick();
    expect(runner.started.at(-1)).toMatchObject({ kind: "issue", issues: [5] });
    expect(runner.started.at(-1)?.prompt).toContain("Use v2");

    // The revision turn ends with nothing new on GitHub: the same feedback is not handed over again.
    store.patchSession(runner.started.length, { state: "idle" });
    await coordinator.tick();
    gh.changed = true;
    await coordinator.tick();
    expect(runner.started).toHaveLength(2);
    expect(runner.resumed).toEqual([]);
  });

  const proposed = async () => {
    gh.items = [item(5)];
    await coordinator.tick();
    finishPlanner(1, [5]);
    await coordinator.tick();
    gh.calls = [];
  };

  test("REQ-001-04 the Owner's /approve approves a proposal and records the notes", async () => {
    await proposed();
    gh.comments.set(5, [
      { id: 950, body: "/approve keep it small", author: OWNER, createdAt: "2026-11-11T09:00:00Z", updatedAt: "" },
    ]);
    gh.changed = true;
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:approved"]);
    expect(store.issue("octo/app", 5)).toMatchObject({
      approvedAt: "2026-11-11T09:00:00Z",
      approvalNotes: "keep it small",
      lastHandledCommentId: 950,
    });
  });

  test("REQ-001-04 an agent:approved label from someone else is removed; from the Owner it approves", async () => {
    await proposed();
    gh.items[0]?.labels.push("agent:approved");
    gh.labelActorOf.set(5, { login: "mallory", id: 666 });
    gh.changed = true;
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:proposed"]);
    expect(store.issue("octo/app", 5).approvedAt).toBeNull();

    gh.items[0]?.labels.push("agent:approved");
    gh.labelActorOf.set(5, OWNER);
    gh.changed = true;
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:approved"]);
    expect(store.issue("octo/app", 5).approvedAt).toBe(now.toISOString());
  });

  test("REQ-001-05 an approved issue waits as agent:blocked until its blocker is closed", async () => {
    gh.items = [item(5), item(8, ["agent:proposed"])];
    store.updateIssue("octo/app", 8, { assessment: "{}" });
    await coordinator.tick();
    writeFileSync(
      join(runner.sessionDir(1), "result.json"),
      JSON.stringify([{ issue: 5, verdict: "proposed", approach: "A", bundleWith: [], blockedBy: [8], questions: [] }]),
    );
    store.patchSession(1, { state: "idle", needsSync: true });
    await coordinator.tick();
    gh.comments.set(5, [{ id: 960, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
    gh.changed = true;
    await coordinator.tick();
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:blocked"]);

    gh.items = gh.items.filter((i) => i.number !== 8);
    gh.changed = true;
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:approved"]);
  });

  test("REQ-001-09 / REQ-001-14 an approved issue is implemented, gets a PR, and is cleaned up once the PR is merged", async () => {
    await proposed();
    gh.checkState = "pending"; // keep the Reviewer out of this one
    gh.comments.set(5, [{ id: 970, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
    gh.changed = true;
    await coordinator.tick(); // approve
    await coordinator.tick(); // implement
    const impl = runner.started.at(-1);
    expect(impl).toMatchObject({ role: "implementer", issues: [5], cwd: "/wt/5" });
    expect(gh.items[0]?.labels).toEqual(["agent:in-progress"]);

    const id = runner.started.length;
    writeFileSync(
      join(runner.sessionDir(id), "result.json"),
      JSON.stringify({ prTitle: "T", prBody: "B", summary: "S" }),
    );
    store.patchSession(id, { state: "idle", needsSync: true });
    gh.items.push(item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } }));
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["createPull", "T"]);
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    expect(runner.started.filter((s) => s.role === "implementer")).toHaveLength(1);

    gh.items = gh.items.filter((i) => i.number !== 70 && i.number !== 5); // merged, issue closed
    gh.changed = true;
    await coordinator.tick();
    expect(worktrees.removed).toEqual(["/wt/5"]);
    expect(store.session(id)?.state).toBe("closed");
    expect(store.issue("octo/app", 5).worktreePath).toBeNull();
  });

  /** An Implementer that finished its first turn with commits, awaiting the sync that opens its PR. */
  const implementerDone = () => {
    // PR #70 is what createPull returns; listing it keeps it open once created.
    gh.items = [item(5, ["agent:in-progress"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
    gh.checkState = "pending"; // keep the Reviewer out
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5" });
    const id = store.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
    store.setClaudeSessionId(id, "claude-impl");
    mkdirSync(runner.sessionDir(id), { recursive: true });
    writeFileSync(
      join(runner.sessionDir(id), "result.json"),
      JSON.stringify({ prTitle: "T", prBody: "B", summary: "S" }),
    );
    store.patchSession(id, { state: "idle", needsSync: true });
    runner.live.add(id);
    return id;
  };

  test("REQ-001-27 a failed sync is retried on the next tick", async () => {
    const id = implementerDone();
    gh.createPullFailures = 1;
    await coordinator.tick();
    expect(gh.calls).not.toContainEqual(["createPull", "T"]);
    expect(store.session(id)?.needsSync).toBe(true);

    await coordinator.tick();
    expect(gh.calls).toContainEqual(["createPull", "T"]);
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    expect(store.session(id)?.needsSync).toBe(false);
  });

  test("REQ-001-27 a failed sync is retried after its session was closed, without failing the issue", async () => {
    const id = implementerDone();
    gh.createPullFailures = 1;
    await coordinator.tick();
    runner.close(id); // e.g. closed as idle (REQ-001-20)
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["createPull", "T"]);
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    expect(gh.calls).not.toContainEqual(["addLabels", 5, ["agent:failed"]]);
  });

  test("REQ-001-27 after 3 failed syncs in a row the issue is labelled agent:failed with the error", async () => {
    implementerDone();
    gh.createPullFailures = 10;
    await coordinator.tick();
    await coordinator.tick();
    expect(gh.calls).not.toContainEqual(["addLabels", 5, ["agent:failed"]]);
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:failed"]);
    expect(gh.calls).toContainEqual(["createComment", 5, expect.stringContaining("403: Resource not accessible")]);
    gh.calls = [];
    await coordinator.tick();
    expect(gh.calls).toEqual([]);
  });

  test("REQ-001-10 / REQ-001-23 an agent PR is reviewed once its checks pass, then the Reviewer closes", async () => {
    gh.items = [item(5, ["agent:pr-open"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70 });
    gh.checkState = "pending";
    await coordinator.tick();
    expect(runner.started).toEqual([]);

    gh.checkState = "success"; // checks finishing does not change the issue list
    await coordinator.tick();
    expect(runner.started).toEqual([expect.objectContaining({ role: "reviewer", issues: [5], cwd: "/reviews/70" })]);
    await coordinator.tick();
    expect(runner.started).toHaveLength(1);

    writeFileSync(join(runner.sessionDir(1), "result.json"), JSON.stringify({ summary: "Good", findings: [] }));
    store.patchSession(1, { state: "idle", needsSync: true });
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["createReview", 70, "h1"]);
    expect(gh.items[0]?.labels).toEqual(["agent:reviewed"]);
    expect(store.session(1)?.state).toBe("closed");
    await coordinator.tick();
    expect(runner.started).toHaveLength(1);
  });

  const prOpen = (extra: Record<string, unknown> = {}) => {
    gh.items = [item(5, ["agent:pr-open"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70, reviewedHeadSha: "h1", ...extra });
    const id = store.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
    store.setClaudeSessionId(id, "claude-impl");
    store.patchSession(id, { state: "idle" });
    runner.live.add(id);
    return id;
  };

  test("REQ-001-11 blocking findings resume the Implementer in a counted Feedback round", async () => {
    const id = prOpen({ pendingFeedback: "Blocking: crash" });
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("Blocking: crash")]]);
    expect(store.issue("octo/app", 5)).toMatchObject({ feedbackRounds: 1, pendingFeedback: null });
    expect(gh.items[0]?.labels).toEqual(["agent:in-progress"]);
  });

  test("REQ-001-11 past maxFeedbackRounds the PR and its issue are labelled agent:failed", async () => {
    prOpen({ pendingFeedback: "Blocking: crash", feedbackRounds: 2 });
    await coordinator.tick();
    expect(runner.resumed).toEqual([]);
    expect(gh.calls).toContainEqual(["addLabels", 5, ["agent:failed"]]);
    expect(gh.calls).toContainEqual(["addLabels", 70, ["agent:failed"]]);
    expect(store.issue("octo/app", 5).pendingFeedback).toBeNull();
  });

  test("REQ-001-13 failing checks start a round with their output, once per head", async () => {
    const id = prOpen();
    gh.checkState = "failure";
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("- test")]]);
    store.patchSession(id, { state: "idle" });
    gh.changed = true;
    await coordinator.tick();
    expect(runner.resumed).toHaveLength(1);
    expect(store.issue("octo/app", 5).feedbackRounds).toBe(1);
  });

  test("REQ-001-12 the Owner's /agent comment and changes-requested review run uncounted rounds; others are ignored", async () => {
    const id = prOpen();
    gh.comments.set(70, [
      { id: 980, body: "/agent do X", author: { login: "mallory", id: 666 }, createdAt: "", updatedAt: "" },
      { id: 981, body: "/agent add docs", author: OWNER, createdAt: "", updatedAt: "" },
    ]);
    gh.reviews.set(70, [
      { id: 5, state: "CHANGES_REQUESTED", body: "Split it", author: OWNER },
      { id: 6, state: "CHANGES_REQUESTED", body: "Evil", author: { login: "mallory", id: 666 } },
    ]);
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("add docs\n\nSplit it")]]);
    expect(runner.resumed[0]?.[1]).not.toContain("do X");
    expect(runner.resumed[0]?.[1]).not.toContain("Evil");
    expect(store.issue("octo/app", 5).feedbackRounds).toBe(0);
    expect(store.issue("octo/app", 70)).toMatchObject({ lastHandledCommentId: 981, lastHandledReviewId: 5 });
  });

  test("REQ-001-24 /wake on a PR resumes its closed Implementer session without a new task", async () => {
    const id = prOpen();
    runner.close(id);
    gh.comments.set(70, [{ id: 990, body: "/wake", author: OWNER, createdAt: "", updatedAt: "" }]);
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("wants to chat")]]);
    expect(runner.kept).toEqual([id]);
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    expect(store.issue("octo/app", 5).feedbackRounds).toBe(0);
    store.patchSession(id, { state: "idle" });
    gh.changed = true;
    await coordinator.tick();
    expect(runner.resumed).toHaveLength(1);
  });

  test("only fetches comments when the repository's issues changed", async () => {
    gh.items = [item(5, ["agent:proposed"])];
    await coordinator.tick();
    await coordinator.tick();
    await coordinator.tick();
    expect(gh.commentFetches).toBe(1);
  });

  test("REQ-001-16 resumes a session interrupted by a restart once, then labels it agent:failed", async () => {
    gh.items = [item(5, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [5] });
    store.setClaudeSessionId(id, "c1");
    mkdirSync(runner.sessionDir(id), { recursive: true });
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("restarted")]]);
    expect(store.session(id)?.resumeAttempts).toBe(1);

    runner.live.clear(); // crashed again
    gh.changed = true;
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["addLabels", 5, ["agent:failed"]]);
    expect(gh.calls).toContainEqual(["removeLabel", 5, "agent:planning"]);
    expect(store.session(id)?.state).toBe("closed");
    expect(runner.resumed).toHaveLength(1);
  });

  test("REQ-001-17 pauses after the usage limit, then continues the interrupted session", async () => {
    gh.items = [item(5), item(6, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [6] });
    store.setClaudeSessionId(id, "c1");
    runner.live.add(id);
    store.patchSession(id, { state: "idle", usageLimited: true });

    await coordinator.tick();
    expect(store.pausedUntil()).toBe(new Date(now.getTime() + USAGE_LIMIT_PAUSE_MIN * 60_000).toISOString());
    expect(runner.started).toEqual([]);
    expect(runner.resumed).toEqual([]);

    now = new Date(now.getTime() + (USAGE_LIMIT_PAUSE_MIN + 1) * 60_000);
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("usage limit")]]);
    expect(store.session(id)?.resumeAttempts).toBe(0);

    // The limit hits again later: the pause is extended.
    store.patchSession(id, { state: "idle", usageLimited: true });
    await coordinator.tick();
    expect(store.pausedUntil()).toBe(new Date(now.getTime() + USAGE_LIMIT_PAUSE_MIN * 60_000).toISOString());
  });

  test("REQ-001-20 closes sessions idle longer than idleTimeoutMin", async () => {
    gh.items = [item(5, ["agent:proposed"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "issue", issues: [5] });
    store.patchSession(id, { state: "idle" });
    runner.live.add(id);
    now = new Date(now.getTime() + 31 * 60_000);
    await coordinator.tick();
    expect(runner.closed).toEqual([id]);
  });

  test("REQ-001-08 limits apply across repositories and new work waits for a free Slot", async () => {
    gh.items = [item(5)];
    const busy = store.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [9] });
    runner.live.add(busy);
    await coordinator.tick();
    expect(runner.started).toEqual([]);
    store.patchSession(busy, { state: "idle" });
    await coordinator.tick();
    expect(runner.started).toHaveLength(1);
  });

  test("an error in one tick is logged and does not stop the loop", async () => {
    const logs: string[] = [];
    const broken = new Coordinator({
      config,
      store,
      gh: { ...gh, listOpenItems: async () => Promise.reject(new Error("GitHub down")) } as unknown as FakeGitHub,
      runner,
      worktrees,
      clones: { mainClone: async () => "/c" },
      now: () => now,
      log: (m) => logs.push(m),
    });
    await broken.tick();
    expect(logs.join("\n")).toContain("GitHub down");
  });
});
