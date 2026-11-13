import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import type { Item, ReviewComment } from "../src/github/client.ts";
import { GitHubError } from "../src/github/http.ts";
import { Reviewer } from "../src/reviewer.ts";
import type { StartOptions } from "../src/runner.ts";
import { Store } from "../src/store.ts";

const config = parseConfig({
  owner: { login: "octo", id: 42 },
  github: { appId: 7, privateKeyPath: "/k.pem" },
  roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app" }],
});

const item = (number: number): Item => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  author: { login: "octo", id: 42 },
  labels: ["agent:pr-open"],
  isPullRequest: false,
  createdAt: "c",
  updatedAt: "u",
});

class FakeGitHub {
  calls: unknown[][] = [];
  rejectInline = false;
  async addLabels(_r: string, issue: number, labels: string[]) {
    this.calls.push(["addLabels", issue, labels]);
  }
  async removeLabel(_r: string, issue: number, label: string) {
    this.calls.push(["removeLabel", issue, label]);
  }
  async createComment(_r: string, issue: number, body: string) {
    this.calls.push(["createComment", issue, body]);
    return 1;
  }
  async setDraft(_r: string, pr: number, draft: boolean) {
    this.calls.push(["setDraft", pr, draft]);
  }
  async createReview(_r: string, pr: number, review: { commitId: string; body: string; comments: ReviewComment[] }) {
    if (this.rejectInline && review.comments.length)
      throw new GitHubError(422, "POST", "/reviews", "Line could not be resolved");
    this.calls.push(["createReview", pr, review]);
  }
  of(name: string) {
    return this.calls.filter((c) => c[0] === name);
  }
}

class FakeWorktrees {
  checkouts: [number, string][] = [];
  removed: string[] = [];
  async reviewCheckout(_repo: string, pr: number, sha: string) {
    this.checkouts.push([pr, sha]);
    return `/reviews/${pr}`;
  }
  reviewPath(_repo: string, pr: number) {
    return `/reviews/${pr}`;
  }
  head() {
    return "h1";
  }
  remove(path: string) {
    this.removed.push(path);
  }
}

class FakeRunner {
  started: StartOptions[] = [];
  closed: number[] = [];
  constructor(
    private store: Store,
    private dir: string,
  ) {}
  start(o: StartOptions) {
    this.started.push(o);
    const id = this.store.createSession({ repo: o.repo, role: o.role, kind: o.kind, issues: o.issues });
    mkdirSync(this.sessionDir(id), { recursive: true });
    return id;
  }
  close(id: number) {
    this.closed.push(id);
    this.store.patchSession(id, { state: "closed" });
  }
  sessionDir(id: number) {
    return join(this.dir, "sessions", String(id));
  }
}

let dir: string;
let store: Store;
let gh: FakeGitHub;
let wt: FakeWorktrees;
let runner: FakeRunner;
let reviewer: Reviewer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rev-"));
  store = new Store(":memory:");
  gh = new FakeGitHub();
  wt = new FakeWorktrees();
  runner = new FakeRunner(store, dir);
  reviewer = new Reviewer({ config, store, gh, runner, worktrees: wt });
  for (const n of [5, 6]) store.updateIssue("octo/app", n, { prNumber: 9, worktreePath: "/wt/5" });
  store.updateIssue("octo/app", 5, {
    assessment: JSON.stringify({
      issue: 5,
      verdict: "proposed",
      approach: "Add a toggle",
      bundleWith: [],
      blockedBy: [],
      questions: [],
    }),
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true });
});

const finding = (blocking: boolean, line = 3) => ({
  path: "src/a.ts",
  line,
  severity: "high",
  blocking,
  body: blocking ? "Crashes on empty input" : "Rename",
});
const finish = (id: number, findings: unknown[]) => {
  writeFileSync(join(runner.sessionDir(id), "result.json"), JSON.stringify({ summary: "Looks mostly fine", findings }));
  store.patchSession(id, { state: "idle", needsSync: true });
};

describe("Reviewer run", () => {
  test("REQ-001-10 starts a fresh read-only session on a checkout of the PR head, with the issue and its Assessment", async () => {
    await reviewer.start("octo/app", 9, [item(5), item(6)], "h1");
    expect(wt.checkouts).toEqual([[9, "h1"]]);
    expect(runner.started).toEqual([
      expect.objectContaining({
        role: "reviewer",
        kind: "issue",
        issues: [5, 6],
        cwd: "/reviews/9",
        model: { model: "opus" },
      }),
    ]);
    const prompt = runner.started[0]?.prompt ?? "";
    expect(prompt).toContain("Body of 5");
    expect(prompt).toContain("Add a toggle");
    expect(prompt).toContain("#9");
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:reviewing"]],
      ["addLabels", 6, ["agent:reviewing"]],
    ]);
  });

  test("REQ-001-10 / REQ-001-23 / REQ-001-29 posts one COMMENT review with inline findings, then closes the session and its checkout", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    store.setModelId(id, "claude-opus-5-5");
    gh.calls = [];
    finish(id, [finding(false)]);
    await reviewer.sync(id);
    const [, pr, review] = gh.of("createReview")[0] as [
      string,
      number,
      { commitId: string; body: string; comments: ReviewComment[] },
    ];
    expect(pr).toBe(9);
    expect(review.commitId).toBe("h1");
    expect(review.body).toStartWith("> [!Note]\n> 🤖 Claude Opus 5.5 (Reviewer) writing on behalf of octo\n");
    expect(review.body).toContain("Looks mostly fine");
    expect(review.comments).toEqual([{ path: "src/a.ts", line: 3, body: "**high**: Rename" }]);
    expect(runner.closed).toEqual([id]);
    expect(wt.removed).toEqual(["/reviews/9"]);
    expect(store.issue("octo/app", 5).reviewedHeadSha).toBe("h1");
  });

  test("REQ-001-11 a Review without blocking findings labels the issue and the PR agent:reviewed", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    gh.calls = [];
    finish(id, [finding(false)]);
    await reviewer.sync(id);
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:reviewed"]],
      ["addLabels", 9, ["agent:reviewed"]],
    ]);
    expect(store.issue("octo/app", 5).pendingFeedback).toBeNull();
  });

  test("REQ-001-11 blocking findings are kept for a Feedback round and the issue goes back to agent:pr-open", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    gh.calls = [];
    finish(id, [finding(true), finding(false)]);
    await reviewer.sync(id);
    expect(gh.of("addLabels")).toEqual([["addLabels", 5, ["agent:pr-open"]]]);
    const pending = store.issue("octo/app", 5).pendingFeedback ?? "";
    expect(pending).toContain("Crashes on empty input");
    expect(pending).toContain("src/a.ts:3");
    expect(pending).not.toContain("Rename");
  });

  test("REQ-001-31 a Review without blocking findings marks the PR ready for review", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, [finding(false)]);
    await reviewer.sync(id);
    expect(gh.of("setDraft")).toEqual([["setDraft", 9, false]]);
  });

  test("REQ-001-31 a Review with blocking findings leaves the PR a draft", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, [finding(true)]);
    await reviewer.sync(id);
    expect(gh.of("setDraft")).toEqual([]);
  });

  test("findings GitHub cannot place inline are posted in the review body instead", async () => {
    gh.rejectInline = true;
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, [finding(true, 999)]);
    await reviewer.sync(id);
    const [, , review] = gh.of("createReview")[0] as [string, number, { body: string; comments: ReviewComment[] }];
    expect(review.comments).toEqual([]);
    expect(review.body).toContain("`src/a.ts:999`");
    expect(review.body).toContain("Crashes on empty input");
  });

  test("REQ-001-21 a Reviewer that gave up on its Result labels the issue agent:failed", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    gh.calls = [];
    store.patchSession(id, { state: "idle", needsSync: true, resultFailures: 3 });
    await reviewer.sync(id);
    expect(gh.of("addLabels")).toEqual([["addLabels", 5, ["agent:failed"]]]);
    expect(runner.closed).toEqual([id]);
    expect(wt.removed).toEqual(["/reviews/9"]);
  });
});
