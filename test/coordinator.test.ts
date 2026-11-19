import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { Coordinator, USAGE_LIMIT_PAUSE_MIN } from "../src/coordinator.ts";
import type { Comment, Item, OpenPull } from "../src/github/client.ts";
import { SessionStartError, type StartOptions } from "../src/runner.ts";
import { Store } from "../src/store.ts";

const OWNER = { login: "octo", id: 42 };
const config = parseConfig({
  owner: OWNER,
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
  /** Linked history (REQ-001-47): the bodies here link nothing, so any call is a test bug. */
  async itemHistory(_r: string, n: number): Promise<never> {
    throw new Error(`unexpected itemHistory(#${n})`);
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
  /** Open PRs with their head branch (REQ-001-42). */
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
    const had = i?.labels.includes(label) ?? false;
    if (i) i.labels = i.labels.filter((l) => l !== label);
    this.changed = true;
    return had;
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
  /** PRs not listed here are drafts (REQ-001-31). */
  drafts = new Map<number, boolean>();
  async setDraft(_r: string, pr: number, draft: boolean) {
    this.calls.push(["setDraft", pr, draft]);
    this.drafts.set(pr, draft);
  }
  async addAssignees(_r: string, issue: number, assignees: string[]) {
    this.calls.push(["addAssignees", issue, assignees]);
  }
  /** A merge GitHub refuses, e.g. branch protection (REQ-001-66). */
  mergeError: Error | null = null;
  async mergePull(_r: string, pr: number, o: { sha: string; method: string }) {
    if (this.mergeError) throw this.mergeError;
    this.calls.push(["mergePull", pr, o.sha, o.method]);
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
      draft: this.drafts.get(pr) ?? true,
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
  async publishScreenshots() {
    return "c0ffee";
  }
  async publishImages() {
    return "c0ffee";
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
  changedFiles() {
    return ["src/a.ts"];
  }
}

/** Behaves like the real runner on top of the store, with "windows" as a set. */
class FakeRunner {
  live = new Set<number>();
  started: StartOptions[] = [];
  resumed: [number, string][] = [];
  closed: number[] = [];
  /** Makes every launch fail like the real runner's: the session is recorded as closed (REQ-001-44). */
  launchError: string | null = null;
  constructor(
    private store: Store,
    private dir: string,
  ) {}
  private failLaunch(id: number): never {
    this.store.patchSession(id, { state: "closed", coordinatorPromptPending: false });
    const s = this.store.session(id);
    if (!s) throw new Error("unknown session");
    throw new SessionStartError(s, new Error(this.launchError ?? ""));
  }
  start(o: StartOptions) {
    this.started.push(o);
    const id = this.store.createSession({ repo: o.repo, role: o.role, kind: o.kind, issues: o.issues });
    if (this.launchError) this.failLaunch(id);
    this.store.setAgentSessionId(id, `claude-${id}`);
    mkdirSync(this.sessionDir(id), { recursive: true });
    this.live.add(id);
    return id;
  }
  kept: number[] = [];
  resume(id: number, prompt: string, _model?: unknown, opts: { keepResult?: boolean } = {}) {
    this.resumed.push([id, prompt]);
    if (this.launchError) this.failLaunch(id);
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
  screens = new Map<number, string>();
  screen(id: number) {
    return this.screens.get(id) ?? "";
  }
  abandoned: number[] = [];
  abandon(id: number) {
    this.abandoned.push(id);
    this.live.delete(id);
    this.store.patchSession(id, { state: "closed", coordinatorPromptPending: false });
  }
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

    // REQ-001-40: the revised Assessment is edited in place, and a Reply below the comment says what changed.
    gh.calls = [];
    finishPlanner(2, [5]);
    await coordinator.tick();
    expect(gh.calls.filter((c) => c[0] === "updateComment")).toHaveLength(0); // same Assessment
    const replies = gh.calls.filter((c) => c[0] === "createComment");
    expect(replies).toEqual([["createComment", 5, expect.stringContaining("#issuecomment-901")]]);

    // The revision turn ends with nothing new on GitHub: the same feedback is not handed over again.
    gh.changed = true;
    await coordinator.tick();
    expect(runner.started).toHaveLength(2);
    expect(runner.resumed).toEqual([]);
  });

  test("REQ-001-41 an edited issue description is planned from scratch, with the open issues as context", async () => {
    gh.items = [item(5), item(6)];
    await coordinator.tick();
    finishPlanner(1, [5, 6]);
    await coordinator.tick();

    const edited = gh.items.find((i) => i.number === 5);
    if (edited) edited.body = "A whole new plan, please";
    gh.changed = true;
    await coordinator.tick();
    expect(runner.started).toHaveLength(2);
    expect(runner.started.at(-1)).toMatchObject({ kind: "issue", issues: [5] });
    const prompt = runner.started.at(-1)?.prompt as string;
    expect(prompt).toContain("A whole new plan, please");
    expect(prompt).toContain("- #6 Issue 6");
    expect(prompt).not.toContain("A5");

    gh.calls = [];
    finishPlanner(2, [5], "needs-refinement");
    await coordinator.tick();
    expect(gh.calls.filter((c) => c[0] === "updateComment")).toHaveLength(1);
    expect(gh.calls.filter((c) => c[0] === "createComment")).toEqual([]);
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
    gh.mergeable = null; // GitHub still computing mergeability keeps the Reviewer out (REQ-001-10/28)
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

  test("REQ-001-59 the Owner's comment on a bundled proposal is answered before the Bundle starts", async () => {
    gh.checkState = "pending";
    gh.items = [item(5), item(6)];
    await coordinator.tick();
    const bundled = (issue: number, other: number) => ({
      issue,
      verdict: "proposed",
      approach: `A${issue}`,
      bundleWith: [other],
      blockedBy: [],
      questions: [],
    });
    writeFileSync(join(runner.sessionDir(1), "result.json"), JSON.stringify([bundled(5, 6), bundled(6, 5)]));
    store.patchSession(1, { state: "idle", needsSync: true });
    await coordinator.tick();

    // #5 is approved; then, before the Bundle starts, the Owner asks for more on #6.
    gh.comments.set(5, [{ id: 970, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
    gh.changed = true;
    await coordinator.tick(); // approve
    gh.comments.set(6, [{ id: 971, body: "add the mockup images", author: OWNER, createdAt: "t", updatedAt: "" }]);
    gh.changed = true;
    await coordinator.tick();
    expect(runner.started.filter((s) => s.role === "implementer")).toEqual([]);
    expect(runner.started.at(-1)).toMatchObject({ role: "planner", issues: [6] });
    expect(gh.items.find((i) => i.number === 6)?.labels).not.toContain("agent:in-progress");

    // Once the revision is synced and replied to, the Bundle starts with both issues.
    const revision = runner.started.length;
    writeFileSync(join(runner.sessionDir(revision), "result.json"), JSON.stringify([bundled(6, 5)]));
    store.patchSession(revision, { state: "idle", needsSync: true });
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["createComment", 6, expect.stringContaining("#issuecomment-971")]);
    await coordinator.tick();
    expect(runner.started.at(-1)).toMatchObject({ role: "implementer", issues: [5, 6] });
  });

  test("REQ-001-14 an issue whose PR was closed without merging is open again without an agent label and planned anew", async () => {
    await proposed();
    gh.mergeable = null; // GitHub still computing mergeability keeps the Reviewer out (REQ-001-10/28)
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
    gh.mergeable = null; // GitHub still computing mergeability keeps the Reviewer out (REQ-001-10/28)
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5" });
    const id = store.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
    store.setAgentSessionId(id, "claude-impl");
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
    gh.mergeable = true;
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

  test("REQ-001-42 / REQ-001-43 a new issue with an orphaned agent PR is not planned; the PR is re-attached and reviewed", async () => {
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

  test("REQ-001-43 an approved issue's orphaned PR is re-attached instead of starting an Implementer; Feedback rounds resume", async () => {
    gh.items = [item(5, ["agent:approved"])];
    store.updateIssue("octo/app", 5, { approvedAt: "2026-11-11T09:00:00Z" });
    gh.openPulls = [orphan()];
    gh.mergeable = false; // REQ-001-64: failing checks of an unreviewed head would wait for its Review
    gh.checkState = "none";
    await coordinator.tick();
    expect(runner.started).toEqual([]);
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    await coordinator.tick();
    expect(runner.started).toMatchObject([{ role: "implementer", issues: [5], cwd: "/wt/5" }]);
    expect(runner.started[0]?.prompt).toContain("Feedback round on PR #34");
  });

  test("REQ-001-43 a re-attached issue with stale agent:failed or agent:in-progress labels ends up only agent:pr-open, and automatic rounds resume", async () => {
    gh.items = [item(5, ["agent:failed", "agent:in-progress"])];
    gh.openPulls = [orphan()];
    gh.mergeable = false; // REQ-001-64: failing checks of an unreviewed head would wait for its Review
    gh.checkState = "none";
    await coordinator.tick();
    expect(gh.items[0]?.labels).toEqual(["agent:pr-open"]);
    expect(gh.calls).not.toContainEqual(["addLabels", 5, ["agent:failed"]]);
    expect(gh.calls.filter((c) => c[0] === "createComment")).toEqual([
      ["createComment", 34, expect.stringContaining("re-attached")],
    ]);
    await coordinator.tick();
    expect(runner.started).toMatchObject([{ role: "implementer", issues: [5], cwd: "/wt/5" }]);
    expect(runner.started[0]?.prompt).toContain("git merge origin/main");
  });

  test("REQ-001-43 a listed PR that GitHub reports closed, or with another branch, is not re-attached", async () => {
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

  test("REQ-001-43 while maxWorktrees is reached nothing is re-attached; a later tick does it", async () => {
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

  test("REQ-001-43 an orphaned agent PR whose issues are all closed is logged once", async () => {
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
        risk: "medium",
        riskReason: "r",
      }),
    );
    store.patchSession(1, { state: "idle", needsSync: true });
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["createReview", 70, "h1"]);
    expect(gh.calls.filter((c) => c[0] === "setDraft")).toEqual([]);
  });

  test("REQ-001-10 / REQ-001-23 / REQ-001-52 / REQ-001-64 an agent PR is reviewed while its checks are pending and leaves draft once they pass, assigning the Owner", async () => {
    gh.items = [item(5, ["agent:pr-open"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70 });
    gh.checkState = "pending";
    await coordinator.tick();
    expect(runner.started).toEqual([expect.objectContaining({ role: "reviewer", issues: [5], cwd: "/reviews/70" })]);
    await coordinator.tick();
    expect(runner.started).toHaveLength(1);

    writeFileSync(
      join(runner.sessionDir(1), "result.json"),
      JSON.stringify({ summary: "Good", findings: [], risk: "medium", riskReason: "r" }),
    );
    store.patchSession(1, { state: "idle", needsSync: true });
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["createReview", 70, "h1"]);
    expect(gh.items[0]?.labels).toEqual(["agent:reviewed"]);
    expect(store.session(1)?.state).toBe("closed");
    await coordinator.tick();
    expect(gh.calls.filter((c) => c[0] === "setDraft" || c[0] === "addAssignees")).toEqual([]); // checks pending

    gh.checkState = "success"; // checks finishing does not change the issue list
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["setDraft", 70, false]); // REQ-001-31
    expect(gh.calls).toContainEqual(["addAssignees", 70, ["octo"]]); // REQ-001-52
    expect(gh.calls.some((c) => c[0] === "requestReviewers")).toBe(false);
    gh.drafts.set(70, true); // the Owner turns it back into a draft
    await coordinator.tick();
    expect(gh.calls.filter((c) => c[0] === "setDraft")).toHaveLength(1);
    expect(runner.started).toHaveLength(1);
  });

  describe("REQ-001-65 / REQ-001-66 auto-merge", () => {
    const events = () => store.events().map((e) => [e.kind, e.issues, e.pr, e.text]);
    /** A Coordinator in the given auto-merge mode, whose PR #70 got a Review without findings at the given tier. */
    const reviewedAt = async (autoMerge: string, risk: string) => {
      coordinator = new Coordinator({
        config: parseConfig({ ...config, autoMerge, dashboard: false }),
        store,
        gh,
        runner,
        worktrees,
        clones: { mainClone: async (repo: string) => `/clones/${repo}` },
        now: () => now,
        log: (m) => logs.push(m),
      });
      gh.items = [item(5, ["agent:pr-open"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
      store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70 });
      gh.checkState = "pending";
      await coordinator.tick();
      writeFileSync(
        join(runner.sessionDir(1), "result.json"),
        JSON.stringify({ summary: "Good", findings: [], risk, riskReason: "Docs only" }),
      );
      store.patchSession(1, { state: "idle", needsSync: true });
      await coordinator.tick();
      gh.calls = [];
    };

    test("evaluated squash-merges a low-risk PR once its checks pass, says why, and cleans up once GitHub reports it merged", async () => {
      await reviewedAt("evaluated", "low");
      await coordinator.tick();
      expect(gh.calls.filter((c) => c[0] === "mergePull")).toEqual([]); // checks pending
      gh.checkState = "success";
      await coordinator.tick();
      expect(gh.calls.filter((c) => c[0] === "mergePull")).toEqual([["mergePull", 70, "h1", "squash"]]);
      expect(gh.calls.some((c) => c[0] === "createComment" && c[1] === 70 && String(c[2]).includes("evaluated"))).toBe(
        true,
      );
      expect(events()[0]).toEqual(["auto-merged", [5], 70, "PR #70 auto-merged (evaluated, Risk tier low)"]);
      await coordinator.tick();
      expect(gh.calls.filter((c) => c[0] === "mergePull")).toHaveLength(1); // once per head
      gh.pullStates.set(70, "merged");
      await coordinator.tick();
      expect(store.issue("octo/app", 5).worktreePath).toBeNull(); // REQ-001-14
    });

    test("evaluated leaves a medium-risk PR to the Owner, as off does", async () => {
      await reviewedAt("evaluated", "medium");
      gh.checkState = "success";
      await coordinator.tick();
      expect(gh.calls.filter((c) => ["setDraft", "addAssignees", "mergePull"].includes(c[0] as string))).toEqual([
        ["setDraft", 70, false],
        ["addAssignees", 70, ["octo"]],
      ]);
    });

    test("a merge GitHub refuses leaves the PR ready for the Owner and records why, once", async () => {
      await reviewedAt("all", "high");
      gh.checkState = "success";
      gh.mergeError = new Error(
        "GitHub PUT /repos/octo/app/pulls/70/merge failed with 405: Repository rule violations",
      );
      await coordinator.tick();
      expect(gh.calls).toContainEqual(["addAssignees", 70, ["octo"]]);
      expect(events()[0]).toEqual([
        "merge-refused",
        [5],
        70,
        "PR #70 not auto-merged: GitHub refused (all, Risk tier high); it is ready for the Owner",
      ]);
      gh.drafts.set(70, false);
      await coordinator.tick();
      expect(events().filter((e) => e[0] === "merge-refused")).toHaveLength(1);
    });
  });

  test("REQ-001-64 failing checks of an unreviewed head wait for its Review, then share one round with the findings", async () => {
    const impl = prOpen({ reviewedHeadSha: null });
    gh.checkState = "failure";
    await coordinator.tick();
    expect(runner.started).toEqual([expect.objectContaining({ role: "reviewer", issues: [5] })]);
    expect(runner.resumed).toEqual([]);
    const reviewId = impl + 1;
    const finding = { path: "a.ts", line: 1, severity: "medium", body: "crash" };
    writeFileSync(
      join(runner.sessionDir(reviewId), "result.json"),
      JSON.stringify({ summary: "S", findings: [finding], risk: "medium", riskReason: "r" }),
    );
    store.patchSession(reviewId, { state: "idle", needsSync: true });
    await coordinator.tick();
    await coordinator.tick();
    expect(runner.resumed).toEqual([
      [impl, expect.stringMatching(/1\. \*\*medium\*\* `a\.ts:1`: crash[\s\S]*Failing checks on h1:\n\n- test/)],
    ]);
    expect(store.issue("octo/app", 5)).toMatchObject({ feedbackRounds: 1, failedChecksSha: "h1" });
  });

  const prOpen = (extra: Record<string, unknown> = {}) => {
    gh.items = [item(5, ["agent:pr-open"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70, reviewedHeadSha: "h1", ...extra });
    const id = store.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
    store.setAgentSessionId(id, "claude-impl");
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
      JSON.stringify({ summary: "S", findings: [finding], risk: "medium", riskReason: "r" }),
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
      JSON.stringify({
        summary: "S",
        findings: [{ path: "a.ts", line: 1, severity: "high", body: "crash" }],
        risk: "medium",
        riskReason: "r",
      }),
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

  test("REQ-001-54 through Review, Feedback round, re-review and failure, the PR's agent label equals its issue's", async () => {
    const impl = prOpen({ reviewedHeadSha: null });
    const agent = (n: number) =>
      (gh.items.find((i) => i.number === n)?.labels ?? []).filter((l) => l.startsWith("agent:"));
    const same = (label: string) => {
      expect(agent(5)).toEqual([label]);
      expect(agent(70)).toEqual([label]);
    };
    await coordinator.tick(); // Review starts
    same("agent:reviewing");
    const review = (id: number, findings: unknown[]) => {
      writeFileSync(
        join(runner.sessionDir(id), "result.json"),
        JSON.stringify({ summary: "S", findings, risk: "medium", riskReason: "r" }),
      );
      store.patchSession(id, { state: "idle", needsSync: true });
    };
    review(impl + 1, [{ path: "a.ts", line: 1, severity: "high", body: "crash" }]);
    await coordinator.tick(); // findings
    same("agent:in-progress");
    await coordinator.tick(); // the Feedback round starts
    expect(runner.resumed).toHaveLength(1);
    same("agent:in-progress");

    worktrees.headSha = "h2";
    gh.heads.set(70, "h2");
    mkdirSync(runner.sessionDir(impl), { recursive: true });
    writeFileSync(
      join(runner.sessionDir(impl), "result.json"),
      JSON.stringify({
        prTitle: "T",
        prBody: "B",
        summary: "Fixed",
        responses: [{ finding: 1, answer: "fixed", reason: "Guarded" }],
      }),
    );
    store.patchSession(impl, { state: "idle", needsSync: true });
    gh.changed = true;
    await coordinator.tick(); // the round ends, then the re-review starts
    expect(runner.started.at(-1)?.role).toBe("reviewer");
    same("agent:reviewing");
    review(store.latestSession("octo/app", 5, "reviewer")?.id ?? 0, []);
    await coordinator.tick();
    same("agent:reviewed");

    store.updateIssue("octo/app", 5, { pendingFeedback: "Blocking: crash", feedbackRounds: 2 });
    gh.changed = true;
    await coordinator.tick(); // past maxFeedbackRounds
    same("agent:failed");
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

  test("REQ-001-54 / REQ-001-16 a Feedback round interrupted again after its one resume labels the PR agent:failed and drafts it", async () => {
    const id = prOpen();
    gh.items[0] = item(5, ["agent:in-progress"]);
    store.patchSession(id, { state: "running" });
    store.recordResume(id); // resumed once already
    runner.live.clear(); // the window is gone a second time
    await coordinator.tick();
    expect(gh.calls).toContainEqual(["addLabels", 5, ["agent:failed"]]);
    expect(gh.calls).toContainEqual(["removeLabel", 70, "agent:in-progress"]);
    expect(gh.calls).toContainEqual(["addLabels", 70, ["agent:failed"]]);
    expect(gh.calls).toContainEqual(["setDraft", 70, true]); // REQ-001-31
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
    expect(gh.items[1]?.labels).toEqual(["agent:in-progress"]); // REQ-001-54
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

  test("REQ-001-10 a new head without checks yet is reviewed right away", async () => {
    prOpen({ reviewedHeadSha: null });
    gh.checkState = "none";
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

  test("REQ-005-03 the Coordinator's own comments under the Owner's id are not feedback", async () => {
    gh.items = [item(5)];
    await coordinator.tick();
    finishPlanner(1, [5]);
    await coordinator.tick();
    const posted = "> [!Note]\n> 🤖 Claude Opus 5.5 (Planner) writing on behalf of octo\n\n## Assessment\n\n/approve";
    gh.comments.set(5, [{ id: 950, body: posted, author: OWNER, createdAt: "", updatedAt: "" }]);
    gh.changed = true;
    await coordinator.tick();
    expect(runner.started).toHaveLength(1);
    expect(gh.items[0]?.labels).toEqual(["agent:proposed"]);
  });

  test("REQ-005-03 the Coordinator's own reviews and comments under the Owner's id don't start a round on a PR", async () => {
    prOpen();
    const note = "> [!Note]\n> 🤖 Claude Opus 5.5 (Reviewer) writing on behalf of octo\n\n";
    gh.comments.set(70, [{ id: 982, body: `${note}/agent do X`, author: OWNER, createdAt: "", updatedAt: "" }]);
    gh.reviews.set(70, [{ id: 7, state: "CHANGES_REQUESTED", body: `${note}Split it`, author: OWNER }]);
    await coordinator.tick();
    expect(runner.resumed).toEqual([]);
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

  describe("REQ-001-57 a session that does not start says why", () => {
    const failComments = (n: number) =>
      gh.calls.filter((c) => c[0] === "createComment" && c[1] === n && String(c[2]).includes("gave up"));
    const SCREEN = " Adding a new directory:\n\n /somewhere\n\n ❯ No, exit\n   Yes, add it\n\n\n";
    /** A Planner for #5 launched now whose prompt Claude Code has not taken (like the real runner's launch). */
    const stuckPlanner = async () => {
      gh.items = [item(5)];
      await coordinator.tick();
      const id = runner.started.length;
      store.patchSession(id, { coordinatorPromptPending: true });
      runner.screens.set(id, SCREEN);
      return id;
    };

    test("is failed with its screen 5 minutes after launch, once", async () => {
      const id = await stuckPlanner();
      now = new Date(now.getTime() + 4 * 60_000);
      await coordinator.tick();
      expect(runner.abandoned).toEqual([]);
      expect(gh.items[0]?.labels).toEqual(["agent:planning"]);

      now = new Date(now.getTime() + 2 * 60_000);
      await coordinator.tick();
      expect(runner.abandoned).toEqual([id]);
      expect(gh.items[0]?.labels).toEqual(["agent:failed"]);
      expect(failComments(5)).toHaveLength(1);
      const body = String(failComments(5)[0]?.[2]);
      expect(body).toContain("Planner session");
      expect(body).toContain("did not start within 5 minutes");
      expect(body).toContain("```\n Adding a new directory:\n\n /somewhere\n\n ❯ No, exit\n   Yes, add it\n```");
      expect(store.sessions("octo/app")).toEqual([]);

      gh.changed = true;
      await coordinator.tick();
      await coordinator.tick();
      expect(failComments(5)).toHaveLength(1);
      expect(runner.started).toHaveLength(1);
    });

    test("a session that took its prompt is never failed this way, however long its turn runs", async () => {
      const id = await stuckPlanner();
      store.patchSession(id, { state: "running", coordinatorPromptPending: false });
      now = new Date(now.getTime() + 3 * 60 * 60_000);
      await coordinator.tick();
      expect(runner.abandoned).toEqual([]);
      expect(failComments(5)).toHaveLength(0);
    });
  });

  describe("REQ-001-44 a session that cannot be launched fails its issues once, with the error", () => {
    const TOO_LONG = "tmux new-window failed: command too long";
    const failComments = (n: number) =>
      gh.calls.filter((c) => c[0] === "createComment" && c[1] === n && String(c[2]).includes("gave up"));
    /** Two more ticks must not fail the issue again (no "never reported its id", no "no … session to resume"). */
    const expectFailedOnce = async (n: number) => {
      gh.changed = true;
      await coordinator.tick();
      await coordinator.tick();
      expect(failComments(n)).toHaveLength(1);
      expect(String(failComments(n)[0]?.[2])).toContain(TOO_LONG);
      expect(store.sessions("octo/app")).toEqual([]);
    };

    test("a Planner pass", async () => {
      gh.items = [item(5)];
      runner.launchError = TOO_LONG;
      await coordinator.tick();
      expect(gh.items[0]?.labels).toEqual(["agent:failed"]);
      expect(String(failComments(5)[0]?.[2])).toContain("Planner session");
      await expectFailedOnce(5);
    });

    const revisionFails = async (own: "batch" | "issue") => {
      await proposed();
      if (own === "issue") {
        const id = store.createSession({ repo: "octo/app", role: "planner", kind: "issue", issues: [5] });
        store.setAgentSessionId(id, "claude-own");
        store.patchSession(id, { state: "idle" });
        runner.live.add(id);
      }
      gh.comments.set(5, [{ id: 901, body: "Use v2", author: OWNER, createdAt: "", updatedAt: "" }]);
      gh.changed = true;
      runner.launchError = TOO_LONG;
      await coordinator.tick();
      expect(gh.items[0]?.labels).toContain("agent:failed");
      await expectFailedOnce(5);
      // The Owner's comment is still unhandled: once the issue is retried, the revision gets it.
      expect(store.issue("octo/app", 5).lastHandledCommentId).toBe(0);
      runner.launchError = null;
      gh.items[0] = { ...item(5), labels: (gh.items[0]?.labels ?? []).filter((l) => l !== "agent:failed") };
      gh.changed = true;
      await coordinator.tick();
      const handedOver = [...runner.started.slice(1).map((o) => o.prompt), ...runner.resumed.map((r) => r[1])];
      expect(handedOver.at(-1)).toContain("Use v2");
      expect(store.issue("octo/app", 5).lastHandledCommentId).toBe(901);
    };

    test("a revision in a new Planner session", () => revisionFails("batch"));
    test("a revision that resumes the issue's Planner session", () => revisionFails("issue"));

    test("a revision from scratch after the Owner edited the issue", async () => {
      await proposed();
      const before = store.issue("octo/app", 5).bodyHash;
      gh.items[0] = { ...item(5, ["agent:proposed"]), body: "Body 5, edited" };
      gh.changed = true;
      runner.launchError = TOO_LONG;
      await coordinator.tick();
      expect(gh.items[0]?.labels).toContain("agent:failed");
      await expectFailedOnce(5);
      // The edit is still unhandled: once the issue is retried, it is planned from scratch.
      expect(store.issue("octo/app", 5).bodyHash).toBe(before);
      runner.launchError = null;
      gh.items[0] = { ...item(5, ["agent:proposed"]), body: "Body 5, edited" };
      gh.changed = true;
      await coordinator.tick();
      expect(runner.started.at(-1)?.prompt).toContain("Body 5, edited");
      expect(store.issue("octo/app", 5).bodyHash).not.toBe(before);
    });

    test("an Implementer run", async () => {
      gh.items = [item(5, ["agent:approved"])];
      store.updateIssue("octo/app", 5, { approvedAt: "2026-11-11T09:00:00Z" });
      gh.labelActorOf.set(5, OWNER);
      runner.launchError = TOO_LONG;
      await coordinator.tick();
      expect(gh.items[0]?.labels).toEqual(["agent:failed"]);
      expect(String(failComments(5)[0]?.[2])).toContain("Implementer session");
      await expectFailedOnce(5);
    });

    test("a Feedback round", async () => {
      const id = prOpen({ pendingFeedback: "Blocking: crash" });
      runner.launchError = TOO_LONG;
      await coordinator.tick();
      expect(runner.resumed).toEqual([[id, expect.stringContaining("Blocking: crash")]]);
      expect(gh.items[0]?.labels).toEqual(["agent:failed"]);
      expect(String(failComments(5)[0]?.[2])).toContain("Implementer session");
      expect(gh.calls).toContainEqual(["addLabels", 70, ["agent:failed"]]);
      await expectFailedOnce(5);
    });

    test("a Review", async () => {
      gh.items = [item(5, ["agent:pr-open"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
      store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70 });
      runner.launchError = TOO_LONG;
      await coordinator.tick();
      expect(gh.items[0]?.labels).toEqual(["agent:failed"]);
      expect(String(failComments(5)[0]?.[2])).toContain("Reviewer session");
      expect(gh.calls).toContainEqual(["addLabels", 70, ["agent:failed"]]);
      await expectFailedOnce(5);
    });
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
    store.setAgentSessionId(id, "c1");
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

  test("REQ-001-62 / REQ-001-16 an idle session whose window is gone after a restart is closed through the runner, so its temp folder goes", async () => {
    gh.items = [item(5, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [5] });
    store.patchSession(id, { state: "idle" });
    await coordinator.tick();
    expect(runner.closed).toContain(id);
    expect(store.session(id)?.state).toBe("closed");
  });

  test("REQ-001-17 with one Account, pauses after the usage limit, then continues the interrupted session", async () => {
    gh.items = [item(5), item(6, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [6] });
    store.setAgentSessionId(id, "c1");
    runner.live.add(id);
    store.patchSession(id, { state: "idle", usageLimited: true });

    await coordinator.tick();
    expect(store.pausedUntil("default")).toBe(new Date(now.getTime() + USAGE_LIMIT_PAUSE_MIN * 60_000).toISOString());
    expect(runner.started).toEqual([]);
    expect(runner.resumed).toEqual([]);
    expect(coordinator.snapshot()?.pausedUntil).toBe(store.pausedUntil("default") ?? "missing");

    now = new Date(now.getTime() + (USAGE_LIMIT_PAUSE_MIN + 1) * 60_000);
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("usage limit")]]);
    expect(store.session(id)?.resumeAttempts).toBe(0);

    // The limit hits again later: the pause is extended.
    store.patchSession(id, { state: "idle", usageLimited: true });
    await coordinator.tick();
    expect(store.pausedUntil("default")).toBe(new Date(now.getTime() + USAGE_LIMIT_PAUSE_MIN * 60_000).toISOString());
  });

  test("REQ-001-17 pauses the Account until the reset time the usage limit reported, not for 30 minutes", async () => {
    gh.items = [item(5), item(6, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [6] });
    store.setAgentSessionId(id, "c1");
    runner.live.add(id);
    // A weekly limit: resets 2026-11-22 10:00 UTC, days after now.
    const resetsAt = "2026-11-22T10:00:00.000Z";
    store.patchSession(id, { state: "idle", usageLimited: true, usageLimitResetsAt: resetsAt });

    await coordinator.tick();
    expect(store.pausedUntil("default")).toBe(resetsAt);
    expect(logs).toContainEqual(expect.stringContaining(`Account default is paused until ${resetsAt}`));
    expect(coordinator.snapshot()?.accounts).toEqual([
      expect.objectContaining({ name: "default", pausedUntil: resetsAt }),
    ]);

    // An hour later, and again a day later: still paused, and the unchanged session logs nothing new.
    const logged = logs.filter((l) => l.includes("usage limit reached")).length;
    for (const minutes of [60, 24 * 60]) {
      now = new Date(now.getTime() + minutes * 60_000);
      gh.changed = true;
      await coordinator.tick();
      expect(runner.started).toEqual([]);
      expect(runner.resumed).toEqual([]);
    }
    expect(logs.filter((l) => l.includes("usage limit reached"))).toHaveLength(logged);
    // Idle past idleTimeoutMin, the session was closed (REQ-001-20), but it is still its issue's session.
    expect(runner.closed).toEqual([id]);
    expect(logs).not.toContainEqual(expect.stringContaining("no planner session to resume"));

    now = new Date(Date.parse(resetsAt) + 60_000);
    await coordinator.tick();
    expect(runner.resumed).toEqual([[id, expect.stringContaining("usage limit")]]);
    expect(runner.started).toEqual([]);
  });

  test("REQ-001-17 without a reset time from the transcript, pauses until the Account's exhausted Usage quota window resets", async () => {
    gh.items = [item(6, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [6] });
    store.setAgentSessionId(id, "c1");
    runner.live.add(id);
    // now is 2026-11-11 10:00 UTC: the 5-hour window has room, the weekly one is used up.
    store.recordUsageQuota("default", {
      fiveHour: { usedPercent: 40, resetsAt: "2026-11-11T13:00:00.000Z" },
      sevenDay: { usedPercent: 100, resetsAt: "2026-11-13T09:00:00.000Z" },
    });
    store.patchSession(id, { state: "idle", usageLimited: true });

    await coordinator.tick();
    expect(store.pausedUntil("default")).toBe("2026-11-13T09:00:00.000Z");
  });

  test("REQ-001-17 a Usage quota that is not used up or already reset leaves the 30-minute pause", async () => {
    gh.items = [item(6, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [6] });
    store.setAgentSessionId(id, "c1");
    runner.live.add(id);
    store.recordUsageQuota("default", {
      fiveHour: { usedPercent: 100, resetsAt: "2026-11-11T09:00:00.000Z" },
      sevenDay: { usedPercent: 99, resetsAt: "2026-11-13T09:00:00.000Z" },
    });
    store.patchSession(id, { state: "idle", usageLimited: true });

    await coordinator.tick();
    expect(store.pausedUntil("default")).toBe(new Date(now.getTime() + USAGE_LIMIT_PAUSE_MIN * 60_000).toISOString());
  });

  test("REQ-001-17 a longer pause that is in force is never shortened", async () => {
    gh.items = [item(6, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [6] });
    store.setAgentSessionId(id, "c1");
    runner.live.add(id);
    store.setPausedUntil("default", "2026-11-22T10:00:00.000Z");
    store.patchSession(id, { state: "idle", usageLimited: true, usageLimitResetsAt: "2026-11-11T12:00:00.000Z" });

    await coordinator.tick();
    expect(store.pausedUntil("default")).toBe("2026-11-22T10:00:00.000Z");
  });

  test("REQ-001-17 / REQ-004-01 a usage limit pauses only its Account; the session continues right away on another one", async () => {
    const two = parseConfig({
      ...config,
      accounts: [
        { name: "a", configDir: "/home/agent/.claude-a" },
        { name: "b", configDir: "/home/agent/.claude-b" },
      ],
    });
    coordinator = new Coordinator({
      config: two,
      store,
      gh,
      runner,
      worktrees,
      clones: { mainClone: async (repo: string) => `/clones/${repo}` },
      now: () => now,
      log: (m) => logs.push(m),
    });
    gh.items = [item(6, ["agent:planning"])];
    const id = store.createSession({ repo: "octo/app", role: "planner", kind: "batch", issues: [6] });
    store.setAgentSessionId(id, "c1");
    store.setAccount(id, "a");
    runner.live.add(id);
    store.patchSession(id, { state: "idle", usageLimited: true });

    await coordinator.tick();
    const until = new Date(now.getTime() + USAGE_LIMIT_PAUSE_MIN * 60_000).toISOString();
    expect(store.pausedUntil("a")).toBe(until);
    expect(store.pausedUntil("b")).toBeUndefined();
    expect(logs).toContainEqual(expect.stringContaining(`Account a is paused until ${until}`));
    expect(runner.resumed).toEqual([[id, expect.stringContaining("usage limit")]]);
    expect(coordinator.snapshot()?.pausedUntil).toBeNull();

    // Then B hits the limit too: all new work waits until the first Account is free again.
    store.setAccount(id, "b");
    now = new Date(now.getTime() + 10 * 60_000);
    store.patchSession(id, { state: "idle", usageLimited: true });
    gh.items = [item(5), item(6, ["agent:planning"])];
    gh.changed = true;
    await coordinator.tick();
    expect(runner.resumed).toHaveLength(1);
    expect(runner.started).toEqual([]);
    expect(coordinator.snapshot()?.queue.map((q) => q.wait)).toEqual([
      { kind: "paused", until },
      { kind: "paused", until },
    ]);
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

  test("REQ-003-01 / REQ-003-02 / REQ-003-04 publishes a snapshot of the tick: issues, agent PRs, sessions and the queue", async () => {
    expect(coordinator.snapshot()).toBeUndefined();
    gh.items = [
      item(5, ["agent:pr-open"]),
      item(6),
      item(7, [], { author: { login: "mallory", id: 666 } }),
      item(9, ["agent:blocked"]),
      item(70, ["agent:pr-open"], { isPullRequest: true, title: "Fix 5", author: { login: "bot", id: 1 } }),
      item(71, [], { isPullRequest: true, author: { login: "mallory", id: 666 } }),
    ];
    store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70, reviewedHeadSha: "h1", feedbackRounds: 1 });
    store.updateIssue("octo/app", 9, { approvedAt: "t", assessment: JSON.stringify({ blockedBy: [6, 99] }) });
    const impl = store.createSession({ repo: "octo/app", role: "implementer", kind: "issue", issues: [5] });
    store.setAgentSessionId(impl, "claude-impl");
    store.patchSession(impl, { state: "idle" });
    runner.live.add(impl);
    await coordinator.tick();

    const snap = coordinator.snapshot();
    expect(snap?.finishedAt).toBe("2026-11-11T10:00:00.000Z");
    expect(snap?.repos).toEqual([
      {
        repo: "octo/app",
        error: null,
        issues: [
          { number: 5, title: "Issue 5", labels: ["agent:pr-open"], blockedBy: [] },
          { number: 6, title: "Issue 6", labels: ["agent:planning"], blockedBy: [] },
          { number: 9, title: "Issue 9", labels: ["agent:blocked"], blockedBy: [6] },
        ],
        pulls: [
          {
            number: 70,
            title: "Fix 5",
            labels: ["agent:pr-open"],
            issues: [5],
            feedbackRounds: 1,
            state: expect.objectContaining({ headSha: "h1", checks: "success", mergeable: true }),
          },
        ],
        worktrees: 1,
      },
    ]);
    expect(snap?.sessions.map((x) => [x.id, x.role, x.live])).toEqual([
      [impl, "implementer", true],
      [impl + 1, "planner", true],
    ]);
    expect(snap?.queue).toEqual([{ work: expect.objectContaining({ key: "octo/app plan", kind: "plan" }) }]);
  });

  test("REQ-001-67 / REQ-003-37 the snapshot holds each Account's Usage quota and pause, in config order", async () => {
    const two = parseConfig({
      ...config,
      accounts: [
        { name: "a", configDir: "/home/agent/.claude-a" },
        { name: "b", configDir: "/home/agent/.claude-b" },
      ],
    });
    coordinator = new Coordinator({
      config: two,
      store,
      gh,
      runner,
      worktrees,
      clones: { mainClone: async (repo: string) => `/clones/${repo}` },
      now: () => now,
      log: () => {},
    });
    store.recordUsageQuota("b", { fiveHour: { usedPercent: 38, resetsAt: "2026-11-11T13:00:00.000Z" } });
    store.setPausedUntil("a", "2026-11-11T14:30:00.000Z");
    await coordinator.tick();
    expect(coordinator.snapshot()?.accounts).toEqual([
      { name: "a", quota: null, pausedUntil: "2026-11-11T14:30:00.000Z" },
      { name: "b", quota: store.usageQuota("b") ?? null, pausedUntil: null },
    ]);
  });

  test("REQ-003-04 an implement job without room for a Worktree waits on maxWorktrees", async () => {
    gh.items = [item(5, ["agent:approved"])];
    store.updateIssue("octo/app", 5, { approvedAt: "2026-11-11T09:00:00Z", assessment: "{}" });
    worktrees.room = false;
    await coordinator.tick();
    expect(runner.started).toEqual([]);
    expect(coordinator.snapshot()?.queue).toEqual([
      { work: expect.objectContaining({ key: "octo/app#5 implement" }), wait: { kind: "max-worktrees" } },
    ]);
  });

  test("REQ-003-06 a repository whose poll failed shows the error in the snapshot", async () => {
    const broken = new Coordinator({
      config,
      store,
      gh: { ...gh, listOpenItems: async () => Promise.reject(new Error("GitHub down")) } as unknown as FakeGitHub,
      runner,
      worktrees,
      clones: { mainClone: async () => "/c" },
      now: () => now,
      log: () => {},
    });
    await broken.tick();
    expect(broken.snapshot()?.repos).toEqual([
      { repo: "octo/app", error: "GitHub down", issues: [], pulls: [], worktrees: 0 },
    ]);
  });

  describe("REQ-003-15 records one Event per action that succeeded on GitHub", () => {
    const events = () => store.events().map((e) => [e.kind, e.issues, e.pr, e.text]);

    test("an Assessment and its verdict, once per new Assessment", async () => {
      gh.items = [item(5)];
      await coordinator.tick();
      expect(events()).toEqual([]);
      finishPlanner(1, [5], "needs-refinement");
      await coordinator.tick();
      expect(events()).toEqual([["assessed", [5], null, "Assessment of #5: needs refinement"]]);
      expect(store.events()[0]?.at).toBe(now.toISOString());
    });

    test("an approval, and an approval of a still blocked issue, then the unblock", async () => {
      await proposed();
      gh.comments.set(5, [{ id: 950, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
      gh.changed = true;
      await coordinator.tick();
      expect(events()[0]).toEqual(["approved", [5], null, "#5 approved"]);

      gh.items = [item(6), item(8, ["agent:proposed"])];
      store.updateIssue("octo/app", 8, { assessment: "{}" });
      gh.changed = true;
      await coordinator.tick();
      const planner = runner.started.length;
      writeFileSync(
        join(runner.sessionDir(planner), "result.json"),
        JSON.stringify([
          { issue: 6, verdict: "proposed", approach: "A", bundleWith: [], blockedBy: [8], questions: [] },
        ]),
      );
      store.patchSession(planner, { state: "idle", needsSync: true });
      await coordinator.tick();
      gh.comments.set(6, [{ id: 960, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
      gh.changed = true;
      await coordinator.tick();
      expect(events()[0]).toEqual(["approved", [6], null, "#6 approved, blocked by #8"]);

      gh.items = gh.items.filter((i) => i.number !== 8);
      gh.changed = true;
      await coordinator.tick();
      expect(events()[0]).toEqual(["unblocked", [6], null, "#6 unblocked"]);
    });

    test("an approved issue that gets blocked", async () => {
      gh.items = [item(5, ["agent:approved"]), item(8, ["agent:proposed"])];
      store.updateIssue("octo/app", 5, { approvedAt: "t", assessment: JSON.stringify({ blockedBy: [8] }) });
      store.updateIssue("octo/app", 8, { assessment: "{}" });
      await coordinator.tick();
      expect(events()).toEqual([["blocked", [5], null, "#5 blocked by #8"]]);
    });

    test("an agent PR opened, and none while opening it fails", async () => {
      implementerDone();
      gh.createPullFailures = 1;
      await coordinator.tick();
      expect(events()).toEqual([]);
      await coordinator.tick();
      expect(events()).toEqual([["pr-opened", [5], 70, "PR #70 opened for #5: T"]]);
    });

    const reviewed = async (findings: unknown[]) => {
      gh.items = [item(5, ["agent:pr-open"]), item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } })];
      store.updateIssue("octo/app", 5, { worktreePath: "/wt/5", prNumber: 70 });
      await coordinator.tick();
      writeFileSync(
        join(runner.sessionDir(1), "result.json"),
        JSON.stringify({ summary: "S", findings, risk: "medium", riskReason: "r" }),
      );
      store.patchSession(1, { state: "idle", needsSync: true });
      await coordinator.tick();
    };

    test("a Review without findings", async () => {
      await reviewed([]);
      expect(events()).toEqual([["review-passed", [5], 70, "Review of PR #70: no findings"]]);
    });

    test("a Review with findings", async () => {
      await reviewed([
        { path: "a.ts", line: 1, severity: "medium", body: "crash" },
        { path: "b.ts", line: 2, severity: "high", body: "data loss" },
      ]);
      // The findings start a Feedback round in the same tick (REQ-001-11), recorded after the Review.
      expect(events()).toEqual([
        ["feedback-round", [5], 70, "Feedback round 1/2 on PR #70"],
        ["review-findings", [5], 70, "Review of PR #70: 2 findings"],
      ]);
    });

    test("a Feedback round, counted or not", async () => {
      const id = prOpen({ pendingFeedback: "Blocking: crash" });
      await coordinator.tick();
      expect(events()).toEqual([["feedback-round", [5], 70, "Feedback round 1/2 on PR #70"]]);

      store.patchSession(id, { state: "idle" });
      gh.comments.set(70, [{ id: 990, body: "/agent rename it", author: OWNER, createdAt: "", updatedAt: "" }]);
      gh.changed = true;
      await coordinator.tick();
      expect(events()[0]).toEqual(["feedback-round", [5], 70, "Feedback round on PR #70 (not counted)"]);
    });

    test("a failed issue, once, with the reason", async () => {
      prOpen({ pendingFeedback: "Blocking: crash", reviewFindings: "[]", feedbackRounds: 2 });
      await coordinator.tick();
      expect(events()).toEqual([
        ["failed", [5], 70, expect.stringMatching(/^#5 failed: .*2 automatic Feedback rounds/)],
      ]);
    });

    test("a failing GitHub call records nothing", async () => {
      await proposed();
      gh.addLabels = async () => {
        throw new Error("GitHub POST labels failed with 502");
      };
      gh.comments.set(5, [{ id: 950, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
      gh.changed = true;
      await coordinator.tick();
      expect(events()).toEqual([["assessed", [5], null, "Assessment of #5: proposed"]]);
    });

    test("a store error while recording is only logged; the tick and the GitHub action go on", async () => {
      await proposed();
      store.recordEvent = () => {
        throw new Error("disk I/O error");
      };
      gh.comments.set(5, [{ id: 950, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
      gh.changed = true;
      await coordinator.tick();
      expect(gh.items[0]?.labels).toEqual(["agent:approved"]);
      expect(logs.join("\n")).toContain("could not record an Event");
      expect(logs.join("\n")).toContain("disk I/O error");
      expect(logs.join("\n")).not.toContain("tick failed");
      expect(coordinator.snapshot()?.finishedAt).toBe(now.toISOString());
    });

    test("REQ-003-16 the snapshot carries the recorded Events, newest first", async () => {
      await proposed();
      gh.comments.set(5, [{ id: 950, body: "/approve", author: OWNER, createdAt: "t", updatedAt: "" }]);
      gh.changed = true;
      await coordinator.tick();
      expect(coordinator.snapshot()?.events.map((e) => e.kind)).toEqual(["approved", "assessed"]);
    });
  });
});

describe("reconcile loop", () => {
  const time = (min: number) => new Date(Date.UTC(2026, 10, 11, 10, min)).toISOString();
  const at = (min: number) => {
    now = new Date(time(min));
  };
  const timings = (issue = 5) =>
    store
      .timings("octo/app", issue)
      .map((t) => [t.phase, t.kind, t.role, t.round, t.start.slice(11, 16), t.end?.slice(11, 16) ?? null]);
  const turnEnds = (id: number, result: unknown) => {
    mkdirSync(runner.sessionDir(id), { recursive: true });
    writeFileSync(join(runner.sessionDir(id), "result.json"), JSON.stringify(result));
    store.patchSession(id, { state: "idle", needsSync: true });
  };

  test("REQ-003-33 one issue through plan, revision, approval, Implementer, checks, Review, Feedback round, re-review and merge", async () => {
    gh.items = [item(5, [], { createdAt: time(0) })];
    at(14);
    await coordinator.tick(); // the Planner pass starts
    at(23);
    finishPlanner(1, [5]);
    await coordinator.tick(); // the Assessment is posted

    gh.comments.set(5, [{ id: 901, body: "Use v2", author: OWNER, createdAt: time(50), updatedAt: "" }]);
    gh.changed = true;
    at(60);
    await coordinator.tick(); // the revision starts
    const revision = runner.started.length;
    expect(runner.started.at(-1)).toMatchObject({ role: "planner", issues: [5] });
    at(66);
    finishPlanner(revision, [5]);
    await coordinator.tick();

    gh.comments.set(5, [
      ...(gh.comments.get(5) ?? []),
      { id: 902, body: "/approve", author: OWNER, createdAt: time(100), updatedAt: "" },
    ]);
    gh.changed = true;
    gh.checkState = "pending";
    at(105);
    await coordinator.tick(); // approve
    at(110);
    await coordinator.tick(); // the Implementer starts
    const impl = runner.started.length;
    expect(runner.started.at(-1)).toMatchObject({ role: "implementer" });
    at(158);
    turnEnds(impl, { prTitle: "T", prBody: "B", summary: "S" });
    gh.items.push(item(70, [], { isPullRequest: true, author: { login: "bot", id: 1 } }));
    at(160);
    await coordinator.tick(); // the PR opens; the Review starts while its checks run
    const review = runner.started.length;
    expect(runner.started.at(-1)).toMatchObject({ role: "reviewer" });

    gh.checkState = "success";
    at(165);
    await coordinator.tick(); // checks done
    expect(runner.started.at(-1)).toMatchObject({ role: "reviewer" });
    at(177);
    turnEnds(review, {
      summary: "S",
      findings: [{ path: "a.ts", line: 1, severity: "high", body: "crash" }],
      risk: "medium",
      riskReason: "r",
    });
    await coordinator.tick(); // the findings start the Feedback round in the same Tick
    expect(runner.resumed.at(-1)?.[0]).toBe(impl);

    worktrees.headSha = "h2";
    gh.heads.set(70, "h2");
    at(194);
    turnEnds(impl, {
      prTitle: "T",
      prBody: "B",
      summary: "Fixed",
      responses: [{ finding: 1, answer: "fixed", reason: "Guarded" }],
    });
    gh.changed = true;
    at(200);
    await coordinator.tick(); // pushed (checks of h2 already done); the re-review starts
    const reReview = runner.started.length;
    expect(runner.started.at(-1)).toMatchObject({ role: "reviewer" });
    at(208);
    turnEnds(reReview, { summary: "Good", findings: [], risk: "medium", riskReason: "r" });
    await coordinator.tick();

    gh.items = gh.items.filter((i) => i.number !== 70 && i.number !== 5);
    gh.pullStates.set(70, "merged");
    gh.changed = true;
    at(250);
    await coordinator.tick(); // merged and cleaned up

    expect(timings()).toEqual([
      ["planning", "queued", "planner", 1, "10:00", "10:14"],
      ["planning", "agent", "planner", 1, "10:14", "10:23"],
      ["planning", "owner", null, 1, "10:23", "10:50"],
      ["planning", "queued", "planner", 2, "10:50", "11:00"],
      ["planning", "agent", "planner", 2, "11:00", "11:06"],
      ["planning", "owner", null, 2, "11:06", "11:40"],
      ["building", "queued", "implementer", 1, "11:40", "11:50"],
      ["building", "agent", "implementer", 1, "11:50", "12:38"],
      // REQ-001-64: the Review starts on the pushed head right away; its checks run alongside, from the push.
      ["review", "queued", "reviewer", 1, "12:38", "12:40"],
      ["review", "agent", "reviewer", 1, "12:40", "12:57"],
      ["review", "checks", null, 1, "12:40", "12:45"],
      ["review", "queued", "implementer", 1, "12:57", "12:57"],
      ["review", "agent", "implementer", 1, "12:57", "13:14"],
      ["review", "queued", "reviewer", 2, "13:14", "13:20"],
      // h2's checks had already passed when its push was first seen: no duration, which the page leaves out.
      ["review", "checks", null, 2, "13:20", "13:20"],
      ["review", "agent", "reviewer", 2, "13:20", "13:28"],
      ["review", "owner", null, 1, "13:28", "14:10"],
    ]);
    expect(store.timedIssues()).toEqual([{ repo: "octo/app", issue: 5, title: "Issue 5", lastAt: time(250) }]);
  });

  test("REQ-003-33 a session whose window is gone while it counted as running is closed at the next Tick", async () => {
    gh.items = [item(5, [], { createdAt: time(0) })];
    at(14);
    await coordinator.tick();
    runner.live.clear(); // the window died with the Coordinator
    at(40);
    await coordinator.tick();
    expect(timings().slice(0, 2)).toEqual([
      ["planning", "queued", "planner", 1, "10:00", "10:14"],
      ["planning", "agent", "planner", 1, "10:14", "10:40"],
    ]);
    // The interrupted session is resumed in the same Tick: a new interval of the same step.
    expect(runner.resumed.at(-1)?.[0]).toBe(1);
    expect(timings()[2]).toEqual(["planning", "agent", "planner", 1, "10:40", null]);
  });
});

describe("reconcile loop with Settings overrides", () => {
  test("REQ-003-36 settings changed after the start apply at the next tick: a lowered maxRunning, another model", async () => {
    const raw = {
      owner: OWNER,
      roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
      repos: [{ name: "octo/app" }, { name: "octo/web" }],
      limits: { maxRunning: 2, maxPlanners: 2, maxLiveSessions: 2 },
    };
    let current = parseConfig(raw);
    coordinator = new Coordinator({
      // As in src/index.ts: the live config, read on every use.
      get config() {
        return current;
      },
      store,
      gh,
      runner,
      worktrees,
      clones: { mainClone: async (repo: string) => `/clones/${repo}` },
      now: () => now,
      log: (m) => logs.push(m),
    });
    current = parseConfig({
      ...raw,
      limits: { ...raw.limits, maxRunning: 1 },
      roles: { ...raw.roles, planner: { model: "haiku", effort: "low" } },
    });
    gh.items = [item(5)];
    await coordinator.tick();
    expect(runner.started.map((s) => [s.repo, s.model])).toEqual([["octo/app", { model: "haiku", effort: "low" }]]);
    expect(coordinator.snapshot()?.queue.find((q) => q.work.key.startsWith("octo/web"))?.wait).toEqual({
      kind: "max-running",
    });
  });
});
