import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { Coordinator, USAGE_LIMIT_PAUSE_MIN } from "../src/coordinator.ts";
import type { Comment, Item, OpenPull } from "../src/github/client.ts";
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
  /** Open PRs with their head branch (REQ-001-40). */
  openPulls: OpenPull[] = [];
  async listOpenPulls() {
    return this.openPulls;
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
  /** Issues it creates are authored by the App, like on GitHub (REQ-001-34). */
  async createIssue(_r: string, issue: { title: string; body: string }) {
    const number = 200 + this.items.length;
    this.calls.push(["createIssue", number, issue.title]);
    this.items.push(item(number, [], { ...issue, author: { login: "coordinator[bot]", id: 900 } }));
    this.changed = true;
    return number;
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
  async setDraft(_r: string, pr: number, draft: boolean) {
    this.calls.push(["setDraft", pr, draft]);
  }
  heads = new Map<number, string>();
  checkState: "none" | "pending" | "success" | "failure" = "success";
  mergeable: boolean | null = true;
  /** PRs not listed here are open (REQ-001-14). */
  pullStates = new Map<number, "open" | "closed" | "merged">();
  /** PRs whose fetch fails, e.g. a network error. */
  failingPulls = new Set<number>();
  async getPull(_r: string, pr: number) {
    if (this.failingPulls.has(pr)) throw new Error(`GitHub GET /repos/octo/app/pulls/${pr} failed with 502`);
    const headSha = this.heads.get(pr) ?? "h1";
    return {
      state: this.pullStates.get(pr) ?? "open",
      number: pr,
      nodeId: `PR_${pr}`,
      draft: true,
      headSha,
      headRef: "agent/5-x",
      baseRef: "main",
      mergeable: this.mergeable,
    };
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
  fetched: string[] = [];
  onFetch = () => {};
  async fetchBase(_repo: string, path: string) {
    this.onFetch();
    this.fetched.push(path);
  }
  room = true;
  hasRoom() {
    return this.room;
  }
  attached: [number[], string][] = [];
  async attach(_repo: string, issues: number[], branch: string) {
    if (!this.room) throw new Error("maxWorktrees (5) reached");
    this.attached.push([issues, branch]);
    return { path: `/wt/${issues[0]}`, branch };
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
  headSha = "h1";
  head() {
    return this.headSha;
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
let logs: string[];

beforeEach(() => {
  logs = [];
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
    log: (m) => logs.push(m),
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

  test("REQ-001-34 a Split-off issue is planned like an Owner issue, and the Owner's /approve approves it", async () => {
    gh.items = [item(5), item(6, [], { author: { login: "coordinator[bot]", id: 900 } })];
    await coordinator.tick();
    const split = [{ issue: 5, verdict: "proposed", approach: "A5", bundleWith: [], blockedBy: [], questions: [] }];
    writeFileSync(
      join(runner.sessionDir(1), "result.json"),
      JSON.stringify([{ ...split[0], splitOff: [{ title: "Parser bug", body: "Found while reading" }] }]),
    );
    store.patchSession(1, { state: "idle", needsSync: true });
    await coordinator.tick();
    expect(gh.calls.filter((c) => c[0] === "createIssue")).toEqual([["createIssue", 202, "Parser bug"]]);
    expect(runner.started.at(-1)).toMatchObject({ kind: "batch", issues: [202] });
    expect(runner.started.at(-1)?.prompt).toContain("- #5 Issue 5");
    expect(runner.started.at(-1)?.prompt).not.toContain("#6 Issue 6"); // other App issues stay out of scope

    finishPlanner(2, [202]);
    await coordinator.tick();
    gh.comments.set(202, [
      { id: 960, body: "/approve", author: OWNER, createdAt: "2026-11-11T09:30:00Z", updatedAt: "" },
    ]);
    gh.changed = true;
    await coordinator.tick();
    expect(store.issue("octo/app", 202).approvedAt).toBe("2026-11-11T09:30:00Z");
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
    gh.calls = [];
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:blocked"]);
    expect(gh.calls).not.toContainEqual(["addLabels", 5, ["agent:approved"]]); // straight to blocked
    expect(store.issue("octo/app", 5).approvedAt).toBe("t");

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
    gh.pullStates.set(70, "merged");
    gh.changed = true;
    await coordinator.tick();
    expect(worktrees.removed).toEqual(["/wt/5"]);
    expect(store.session(id)?.state).toBe("closed");
    expect(store.issue("octo/app", 5).worktreePath).toBeNull();
  });

  test("REQ-001-14 an issue whose PR was closed without merging is open again without an agent label and planned anew", async () => {
    await proposed();
    gh.checkState = "pending";
    gh.comments.set(5, [{ id: 970, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
    gh.changed = true;
    await coordinator.tick(); // approve
    await coordinator.tick(); // implement
    const id = runner.started.length;
    writeFileSync(
      join(runner.sessionDir(id), "result.json"),
      JSON.stringify({ prTitle: "T", prBody: "B", summary: "S" }),
    );
    store.patchSession(id, { state: "idle", needsSync: true });
    gh.items.push(item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } }));
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);

    gh.items = gh.items.filter((i) => i.number !== 70); // closed unmerged; the issue stays open
    gh.pullStates.set(70, "closed");
    gh.changed = true;
    await coordinator.tick(); // cleanup
    expect(gh.items[0]?.labels).toEqual([]);
    gh.changed = true;
    await coordinator.tick();
    expect(runner.started.at(-1)).toMatchObject({ role: "planner", kind: "batch", issues: [5] });
    expect(gh.items[0]?.labels).toEqual(["agent:planning"]);
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

  test("REQ-001-14 a PR missing from a cached (304) or lagging list right after it was opened keeps its Worktree and gets a Review", async () => {
    const id = implementerDone();
    gh.items = gh.items.filter((i) => i.number !== 70); // GitHub's list doesn't show the new PR yet
    gh.checkState = "success";
    await coordinator.tick(); // sync opens PR #70
    expect(gh.calls).toContainEqual(["createPull", "T"]);
    expect(store.issue("octo/app", 5).prNumber).toBe(70);
    gh.changed = false; // 304: the cached view without PR #70
    await coordinator.tick();
    expect(worktrees.removed).toEqual([]);
    expect(store.issue("octo/app", 5).worktreePath).toBe("/wt/5");
    expect(gh.items[0]?.labels).toEqual(["agent:reviewing"]); // not cleared by a cleanup
    expect(logs.join("\n")).not.toContain("is closed");
    expect(runner.started.filter((s) => s.role === "reviewer")).toMatchObject([{ issues: [5] }]);
    expect(store.session(id)?.state).not.toBe("closed");
  });

  test("REQ-001-14 when a PR can't be fetched nothing is cleaned up; the fetch is logged and retried next tick", async () => {
    gh.items = [item(5, ["agent:pr-open"])];
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70 });
    gh.pullStates.set(70, "closed");
    gh.failingPulls.add(70);
    await coordinator.tick();
    expect(worktrees.removed).toEqual([]);
    expect(logs.join("\n")).toContain("pulls/70 failed with 502");

    gh.failingPulls.clear();
    await coordinator.tick();
    expect(worktrees.removed).toEqual(["/wt/5"]);
    expect(store.issue("octo/app", 5)).toMatchObject({ worktreePath: null, prNumber: null });
  });

  const orphan = (): OpenPull => ({ number: 34, headRef: "agent/5-x", headRepo: "octo/app", body: "B\n\nCloses #5" });

  test("REQ-001-40 / REQ-001-41 a new issue with an orphaned agent PR is not planned; the PR is re-attached and reviewed", async () => {
    gh.items = [item(5), item(34, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
    gh.openPulls = [orphan()];
    await coordinator.tick();
    expect(gh.calls).not.toContainEqual(["addLabels", 5, ["agent:planning"]]);
    expect(runner.started.filter((x) => x.role === "planner")).toEqual([]);
    expect(worktrees.attached).toEqual([[[5], "agent/5-x"]]);
    expect(store.issue("octo/app", 5)).toMatchObject({ worktreePath: "/wt/5", prNumber: 34 });
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    const comments = () => gh.calls.filter((c) => c[0] === "createComment");
    expect(comments()).toEqual([["createComment", 34, expect.stringContaining("re-attached")]]);
    expect(logs.join("\n")).toContain("re-attached PR #34");

    await coordinator.tick();
    expect(runner.started.filter((x) => x.role === "reviewer")).toMatchObject([{ issues: [5] }]);
    expect(gh.items[0]?.labels).toEqual(["agent:reviewing"]);
    await coordinator.tick();
    expect(worktrees.attached).toHaveLength(1);
    expect(comments()).toHaveLength(1);
  });

  test("REQ-001-41 an approved issue's orphaned PR is re-attached instead of starting an Implementer; Feedback rounds resume", async () => {
    gh.items = [item(5, ["agent:approved"])];
    store.updateIssue("octo/app", 5, { approvedAt: "2026-11-11T09:00:00Z" });
    gh.openPulls = [orphan()];
    gh.checkState = "failure";
    await coordinator.tick();
    expect(runner.started).toEqual([]);
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    await coordinator.tick();
    expect(runner.started).toMatchObject([{ role: "implementer", issues: [5], cwd: "/wt/5" }]);
    expect(runner.started[0]?.prompt).toContain("Feedback round on PR #34");
  });

  test("REQ-001-41 a re-attached issue with stale agent:failed or agent:in-progress labels ends up only agent:pr-open, and automatic rounds resume", async () => {
    gh.items = [item(5, ["agent:failed", "agent:in-progress"])];
    gh.openPulls = [orphan()];
    gh.checkState = "failure";
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    expect(gh.calls).not.toContainEqual(["addLabels", 5, ["agent:failed"]]);
    expect(gh.calls.filter((c) => c[0] === "createComment")).toEqual([
      ["createComment", 34, expect.stringContaining("re-attached")],
    ]);
    await coordinator.tick();
    expect(runner.started).toMatchObject([{ role: "implementer", issues: [5], cwd: "/wt/5" }]);
    expect(runner.started[0]?.prompt).toContain("Failing checks");
  });

  test("REQ-001-41 a listed PR that GitHub reports closed, or with another branch, is not re-attached", async () => {
    gh.items = [item(5)];
    gh.openPulls = [orphan()];
    gh.pullStates.set(34, "closed"); // the open list lags behind
    await coordinator.tick();
    gh.pullStates.clear();
    gh.openPulls = [{ ...orphan(), headRef: "agent/5-other" }]; // getPull says agent/5-x
    await coordinator.tick();
    expect(worktrees.attached).toEqual([]);
    expect(store.issue("octo/app", 5).prNumber).toBeNull();
    expect(gh.calls.filter((c) => c[0] === "createComment")).toEqual([]);
  });

  test("REQ-001-41 while maxWorktrees is reached nothing is re-attached; a later tick does it", async () => {
    gh.items = [item(5)];
    gh.openPulls = [orphan()];
    worktrees.room = false;
    await coordinator.tick();
    expect(store.issue("octo/app", 5).prNumber).toBeNull();
    expect(gh.items[0]?.labels).toEqual([]);
    expect(logs.join("\n")).toContain("maxWorktrees");
    worktrees.room = true;
    await coordinator.tick();
    expect(store.issue("octo/app", 5).prNumber).toBe(34);
  });

  test("REQ-001-41 an orphaned agent PR whose issues are all closed is logged once", async () => {
    gh.items = [];
    gh.openPulls = [orphan()];
    await coordinator.tick();
    await coordinator.tick();
    expect(logs.filter((l) => l.includes("PR #34"))).toHaveLength(1);
    expect(worktrees.attached).toEqual([]);
  });

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

  test("REQ-001-29 the Coordinator gives up in its own name and names the failed session's Role", async () => {
    implementerDone();
    gh.createPullFailures = 10;
    for (let i = 0; i < 3; i++) await coordinator.tick();
    const comment = gh.calls.find((c) => c[0] === "createComment" && c[1] === 5)?.[2] as string;
    expect(comment).toStartWith("> [!Note]\n> 🤖 Coordinator writing on behalf of ");
    expect(comment).toContain("Implementer session");
    expect(comment).not.toContain("Claude (");
  });

  test("REQ-001-31 an agent PR is a draft until a Review without findings", async () => {
    gh.items = [item(5, ["agent:pr-open"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70 });
    await coordinator.tick();
    writeFileSync(
      join(runner.sessionDir(1), "result.json"),
      JSON.stringify({
        summary: "Crashes",
        findings: [{ path: "a.ts", line: 1, severity: "medium", body: "crash" }],
      }),
    );
    store.patchSession(1, { state: "idle", needsSync: true });
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["createReview", 70, "h1"]);
    expect(gh.calls.filter((c) => c[0] === "setDraft")).toEqual([]);
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
    expect(gh.calls).toContainEqual(["setDraft", 70, false]); // REQ-001-31
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

  test("REQ-001-11 Review findings resume the Implementer in a counted Feedback round", async () => {
    const id = prOpen({ pendingFeedback: "Blocking: crash" });
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("Blocking: crash")]]);
    expect(store.issue("octo/app", 5)).toMatchObject({ feedbackRounds: 1, pendingFeedback: null });
    expect(gh.items[0]?.labels).toEqual(["agent:in-progress"]);
  });

  test("REQ-001-11 / REQ-001-35 / REQ-001-36 a medium finding is fixed in a round, answered on the PR and shown to the re-review", async () => {
    const impl = prOpen({ reviewedHeadSha: null });
    await coordinator.tick();
    const review = runner.started.at(-1);
    expect(review?.role).toBe("reviewer");
    const reviewId = impl + 1;
    const finding = { path: "a.ts", line: 1, severity: "medium", body: "No test for empty input" };
    writeFileSync(
      join(runner.sessionDir(reviewId), "result.json"),
      JSON.stringify({ summary: "S", findings: [finding] }),
    );
    store.patchSession(reviewId, { state: "idle", needsSync: true });
    await coordinator.tick();
    await coordinator.tick();
    expect(runner.resumed).toEqual([
      [impl, expect.stringContaining("1. **medium** `a.ts:1`: No test for empty input")],
    ]);

    worktrees.headSha = "h2";
    gh.heads.set(70, "h2");
    mkdirSync(runner.sessionDir(impl), { recursive: true });
    writeFileSync(
      join(runner.sessionDir(impl), "result.json"),
      JSON.stringify({
        prTitle: "T",
        prBody: "B",
        summary: "Added the test",
        responses: [{ finding: 1, answer: "fixed", reason: "Added a test for empty input" }],
      }),
    );
    store.patchSession(impl, { state: "idle", needsSync: true });
    gh.changed = true;
    await coordinator.tick();
    await coordinator.tick();
    const answers = gh.calls.filter((c) => c[0] === "createComment" && c[1] === 70);
    expect(answers).toEqual([
      ["createComment", 70, expect.stringContaining("**Fixed**: Added a test for empty input")],
    ]);
    const reReview = runner.started.at(-1);
    expect(reReview?.role).toBe("reviewer");
    expect(reReview).not.toBe(review);
    expect(reReview?.prompt).toContain("No test for empty input");
    expect(reReview?.prompt).toContain("**Fixed**: Added a test for empty input");
  });

  test("REQ-001-39 Review findings take the issue from agent:reviewing to agent:in-progress without agent:pr-open, also across a restart", async () => {
    const impl = prOpen({ reviewedHeadSha: null });
    await coordinator.tick();
    const reviewId = impl + 1;
    expect(runner.started.at(-1)?.role).toBe("reviewer");
    writeFileSync(
      join(runner.sessionDir(reviewId), "result.json"),
      JSON.stringify({ summary: "S", findings: [{ path: "a.ts", line: 1, severity: "high", body: "crash" }] }),
    );
    store.patchSession(reviewId, { state: "idle", needsSync: true });
    // A restart closed the Implementer's window before its round could start.
    runner.live.delete(impl);
    gh.calls = [];
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:in-progress"]);
    await coordinator.tick();
    await coordinator.tick();
    expect(runner.resumed).toEqual([[impl, expect.stringContaining("crash")]]);
    const labels = gh.calls.filter((c) => (c[0] === "addLabels" || c[0] === "removeLabel") && c[1] === 5);
    expect(labels.filter((c) => c[0] === "addLabels")).toEqual([
      ["addLabels", 5, ["agent:in-progress"]],
      ["addLabels", 5, ["agent:in-progress"]],
    ]);
    expect(labels).toContainEqual(["removeLabel", 5, "agent:reviewing"]);
    expect(labels).not.toContainEqual(["addLabels", 5, ["agent:failed"]]); // the round only clears it (REQ-001-37)
    expect(gh.items[0]?.labels).toEqual(["agent:in-progress"]);
  });

  test("REQ-001-11 past maxFeedbackRounds the PR and its issue are labelled agent:failed", async () => {
    prOpen({ pendingFeedback: "Blocking: crash", reviewFindings: "[]", feedbackRounds: 2 });
    await coordinator.tick();
    expect(runner.resumed).toEqual([]);
    expect(gh.calls).toContainEqual(["addLabels", 5, ["agent:failed"]]);
    expect(gh.calls).toContainEqual(["addLabels", 70, ["agent:failed"]]);
    expect(gh.calls).toContainEqual(["setDraft", 70, true]); // REQ-001-31
    expect(store.issue("octo/app", 5).pendingFeedback).toBeNull();
    // REQ-001-35: a later Owner round must not have to answer findings its prompt doesn't list.
    expect(store.issue("octo/app", 5).reviewFindings).toBeNull();
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

  test("REQ-001-28 merge conflicts fetch the default branch, then start an uncounted round, once per head", async () => {
    const id = prOpen({ reviewedHeadSha: null });
    gh.mergeable = false;
    gh.checkState = "none"; // GitHub runs no checks on a conflicted PR
    let resumedBeforeFetch = -1;
    worktrees.onFetch = () => {
      resumedBeforeFetch = runner.resumed.length;
    };
    await coordinator.tick();
    expect(worktrees.fetched).toEqual(["/wt/5"]);
    expect(resumedBeforeFetch).toBe(0);
    expect(runner.resumed).toEqual([[id, expect.stringContaining("git merge origin/main")]]);
    expect(runner.started).toEqual([]); // no Review while conflicted
    expect(store.issue("octo/app", 5)).toMatchObject({ feedbackRounds: 0, conflictSha: "h1" });
    store.patchSession(id, { state: "idle" });
    gh.changed = true;
    now = new Date(now.getTime() + 10 * 60_000);
    await coordinator.tick();
    expect(runner.resumed).toHaveLength(1);
    expect(runner.started).toEqual([]);
  });

  test("REQ-001-28 a reviewed PR that conflicts after maxFeedbackRounds gets a merge round, then goes back to draft and is reviewed", async () => {
    const id = prOpen({ feedbackRounds: 2 });
    gh.items[0] = item(5, ["agent:reviewed"]);
    gh.mergeable = false;
    gh.checkState = "none";
    await coordinator.tick();
    expect(worktrees.fetched).toEqual(["/wt/5"]);
    expect(runner.resumed).toEqual([[id, expect.stringContaining("git merge origin/main")]]);
    expect(gh.calls).not.toContainEqual(["addLabels", 5, ["agent:failed"]]);

    worktrees.headSha = "h2";
    gh.heads.set(70, "h2");
    gh.mergeable = true;
    gh.checkState = "success";
    mkdirSync(runner.sessionDir(id), { recursive: true });
    writeFileSync(
      join(runner.sessionDir(id), "result.json"),
      JSON.stringify({ prTitle: "T", prBody: "B", summary: "Merged main" }),
    );
    store.patchSession(id, { state: "idle", needsSync: true });
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["setDraft", 70, true]); // REQ-001-31
    expect(runner.started).toEqual([expect.objectContaining({ role: "reviewer", issues: [5] })]);
    expect(gh.items[0]?.labels).toEqual(["agent:reviewing"]);
  });

  test("REQ-001-38 a conflict round that ends without a new commit tells the Owner on the PR, once", async () => {
    const id = prOpen();
    gh.mergeable = false;
    gh.checkState = "none";
    await coordinator.tick();
    expect(runner.resumed).toHaveLength(1);
    mkdirSync(runner.sessionDir(id), { recursive: true });
    writeFileSync(
      join(runner.sessionDir(id), "result.json"),
      JSON.stringify({ prTitle: "T", prBody: "B", summary: "Could not resolve the conflicts" }),
    );
    store.patchSession(id, { state: "idle", needsSync: true });
    await coordinator.tick();
    await coordinator.tick();
    const comments = gh.calls.filter((c) => c[0] === "createComment");
    expect(comments).toEqual([
      ["createComment", 70, expect.stringContaining("the PR still has merge conflicts with its base branch")],
    ]);
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    expect(runner.resumed).toHaveLength(1);
  });

  test("REQ-001-37 the Owner's /agent on a failed, conflicting PR fetches the base, runs an uncounted round and clears agent:failed", async () => {
    const id = prOpen({ feedbackRounds: 2, conflictSha: "h1" });
    gh.items = [
      item(5, ["agent:failed"]),
      item(70, ["agent:failed"], { isPullRequest: true, author: { login: "bot", id: 1 } }),
    ];
    gh.mergeable = false;
    gh.checkState = "none";
    await coordinator.tick();
    expect(runner.resumed).toEqual([]);
    gh.comments.set(70, [{ id: 991, body: "/agent fix the conflicts", author: OWNER, createdAt: "", updatedAt: "" }]);
    gh.changed = true;
    await coordinator.tick();
    expect(worktrees.fetched).toEqual(["/wt/5"]);
    expect(runner.resumed).toEqual([[id, expect.stringMatching(/fix the conflicts[\s\S]*git merge origin\/main/)]]);
    expect(store.issue("octo/app", 5).feedbackRounds).toBe(2);
    expect(gh.items[0]?.labels).toEqual(["agent:in-progress"]);
    expect(gh.items[1]?.labels).toEqual([]);
  });

  test("REQ-001-13 past maxFeedbackRounds, failing checks give up once per head, not on every tick", async () => {
    prOpen({ feedbackRounds: 2 });
    gh.checkState = "failure";
    await coordinator.tick();
    gh.items[0] = item(5, ["agent:pr-open"]); // e.g. the Owner removed agent:failed by hand
    gh.changed = true;
    await coordinator.tick();
    const gaveUp = gh.calls.filter((c) => c[0] === "createComment" && String(c[2]).includes("gave up"));
    expect(gaveUp).toHaveLength(1);
    expect(store.issue("octo/app", 5).failedChecksSha).toBe("h1");
  });

  test("REQ-001-10 a new head without checks is reviewed only after the grace period", async () => {
    prOpen({ reviewedHeadSha: null });
    gh.checkState = "none";
    await coordinator.tick();
    expect(runner.started).toEqual([]);
    now = new Date(now.getTime() + 60_000);
    await coordinator.tick();
    expect(runner.started).toEqual([]);
    now = new Date(now.getTime() + 61_000);
    await coordinator.tick();
    expect(runner.started).toEqual([expect.objectContaining({ role: "reviewer", issues: [5] })]);
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
