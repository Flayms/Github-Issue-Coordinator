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
  rejectAssignees = false;
  /** Labels on each issue and PR, as GitHub would have them after the calls. */
  labels = new Map<number, Set<string>>();
  async addLabels(_r: string, issue: number, labels: string[]) {
    this.calls.push(["addLabels", issue, labels]);
    for (const l of labels) this.labels.set(issue, new Set([...(this.labels.get(issue) ?? []), l]));
  }
  async removeLabel(_r: string, issue: number, label: string) {
    this.calls.push(["removeLabel", issue, label]);
    return this.labels.get(issue)?.delete(label) ?? false;
  }
  agentLabels(n: number) {
    return [...(this.labels.get(n) ?? [])].filter((l) => l.startsWith("agent:")).sort();
  }
  async createComment(_r: string, issue: number, body: string) {
    this.calls.push(["createComment", issue, body]);
    return 1;
  }
  async setDraft(_r: string, pr: number, draft: boolean) {
    this.calls.push(["setDraft", pr, draft]);
  }
  async addAssignees(_r: string, issue: number, assignees: string[]) {
    if (this.rejectAssignees)
      throw new GitHubError(403, "POST", "/assignees", "Resource not accessible by integration");
    this.calls.push(["addAssignees", issue, assignees]);
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
    const id = this.store.createSession({ repo: o.repo, role: o.role, kind: o.kind, issues: o.issues, title: o.title });
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
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rev-"));
  store = new Store(":memory:");
  gh = new FakeGitHub();
  wt = new FakeWorktrees();
  runner = new FakeRunner(store, dir);
  logs = [];
  reviewer = new Reviewer({ config, store, gh, runner, worktrees: wt, log: (m) => logs.push(m) });
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

const finding = (severity: "high" | "medium" = "high", line = 3, body = "Crashes on empty input") => ({
  path: "src/a.ts",
  line,
  severity,
  body,
});
const finish = (id: number, findings: unknown[]) => {
  writeFileSync(join(runner.sessionDir(id), "result.json"), JSON.stringify({ summary: "Looks mostly fine", findings }));
  store.patchSession(id, { state: "idle", needsSync: true });
};

describe("Reviewer run", () => {
  test("REQ-001-10 / REQ-001-33 starts a fresh read-only session on a checkout of the PR head, with the issue and its Assessment", async () => {
    await reviewer.start("octo/app", 9, [item(5), item(6)], "h1");
    expect(wt.checkouts).toEqual([[9, "h1"]]);
    expect(runner.started).toEqual([
      expect.objectContaining({
        role: "reviewer",
        kind: "issue",
        issues: [5, 6],
        title: "Issue 5",
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
      ["addLabels", 9, ["agent:reviewing"]], // REQ-001-53
    ]);
  });

  test("REQ-001-10 / REQ-001-23 / REQ-001-29 posts one COMMENT review with inline findings, then closes the session and its checkout", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    store.setModelId(id, "claude-opus-5-5");
    gh.calls = [];
    finish(id, [finding("high", 3, "Rename")]);
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

  test("REQ-001-11 a Review without findings labels the issue and the PR agent:reviewed", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    gh.calls = [];
    finish(id, []);
    await reviewer.sync(id);
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:reviewed"]],
      ["addLabels", 9, ["agent:reviewed"]],
    ]);
    expect(store.issue("octo/app", 5).pendingFeedback).toBeNull();
    expect(store.issue("octo/app", 5).reviewFindings).toBeNull();
  });

  test("REQ-001-11 / REQ-001-39 every finding, a single medium one too, is kept numbered for a Feedback round and the issue goes straight to agent:in-progress", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5), item(6)], "h1");
    gh.calls = [];
    finish(id, [finding("high"), finding("medium", 7, "Missing test for REQ-001-11")]);
    await reviewer.sync(id);
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:in-progress"]],
      ["addLabels", 6, ["agent:in-progress"]],
      ["addLabels", 9, ["agent:in-progress"]], // REQ-001-53
    ]);
    const pending = store.issue("octo/app", 5).pendingFeedback ?? "";
    expect(pending).toContain("1. **high** `src/a.ts:3`: Crashes on empty input");
    expect(pending).toContain("2. **medium** `src/a.ts:7`: Missing test for REQ-001-11");
    expect(pending).toContain("responses");
    for (const n of [5, 6])
      expect(JSON.parse(store.issue("octo/app", n).reviewFindings ?? "null")).toEqual([
        finding("high"),
        finding("medium", 7, "Missing test for REQ-001-11"),
      ]);

    const single = await reviewer.start("octo/app", 9, [item(5)], "h2");
    finish(single, [finding("medium")]);
    await reviewer.sync(single);
    expect(store.issue("octo/app", 5).pendingFeedback).toContain("1. **medium** `src/a.ts:3`");
  });

  test("REQ-001-31 a Review without findings marks the PR ready for review", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, []);
    await reviewer.sync(id);
    expect(gh.of("setDraft")).toEqual([["setDraft", 9, false]]);
  });

  test("REQ-001-31 a Review with any finding leaves the PR a draft", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, [finding("medium")]);
    await reviewer.sync(id);
    expect(gh.of("setDraft")).toEqual([]);
  });

  test("REQ-001-52 a Review without findings assigns the Owner to the PR after it leaves draft", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, []);
    await reviewer.sync(id);
    expect(gh.of("addAssignees")).toEqual([["addAssignees", 9, ["octo"]]]);
    expect(gh.calls.findIndex((c) => c[0] === "setDraft")).toBeLessThan(
      gh.calls.findIndex((c) => c[0] === "addAssignees"),
    );
  });

  test("REQ-001-52 a Review with any finding assigns nobody", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, [finding("medium")]);
    await reviewer.sync(id);
    expect(gh.of("addAssignees")).toEqual([]);
  });

  test("REQ-001-52 a refused assignment is logged; the PR is still ready and nothing fails", async () => {
    gh.rejectAssignees = true;
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, []);
    await reviewer.sync(id);
    expect(gh.of("setDraft")).toEqual([["setDraft", 9, false]]);
    expect(gh.calls.flatMap((c) => (c[0] === "addLabels" ? (c[2] as string[]) : []))).not.toContain("agent:failed");
    expect(logs.some((m) => m.includes("PR #9") && m.includes("Resource not accessible by integration"))).toBe(true);
    expect(runner.closed).toEqual([id]);
  });

  test("REQ-001-36 a re-review's context holds the earlier findings and the Implementer's answers", async () => {
    store.updateIssue("octo/app", 5, {
      reviewHistory: "1. **medium** `src/a.ts:3`: Rename it\n\n   **Declined**: The name is in the glossary",
    });
    await reviewer.start("octo/app", 9, [item(5)], "h2");
    const prompt = runner.started[0]?.prompt ?? "";
    expect(prompt).toContain("## Earlier Reviews and the Implementer's answers");
    expect(prompt).toContain("Rename it");
    expect(prompt).toContain("The name is in the glossary");
    expect(prompt).toMatch(/declined finding again only if you say why/i);
  });

  test("REQ-001-36 a first Review has no earlier-Reviews section", async () => {
    await reviewer.start("octo/app", 9, [item(5)], "h1");
    expect(runner.started[0]?.prompt).not.toContain("Earlier Reviews");
  });

  test("findings GitHub cannot place inline are posted in the review body instead", async () => {
    gh.rejectInline = true;
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    finish(id, [finding("high", 999)]);
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
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:failed"]],
      ["addLabels", 9, ["agent:failed"]], // REQ-001-53
    ]);
    expect(runner.closed).toEqual([id]);
    expect(wt.removed).toEqual(["/reviews/9"]);
  });

  test("REQ-003-15 a Reviewer that gave up on its Result records a failure Event", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5)], "h1");
    store.patchSession(id, { state: "idle", needsSync: true, resultFailures: 3 });
    await reviewer.sync(id);
    expect(store.events().map((e) => [e.kind, e.issues, e.pr, e.text])).toEqual([
      ["failed", [5], 9, "#5 failed: the Reviewer could not produce a valid Result"],
    ]);
  });
});

describe("REQ-001-53 an agent PR shows its state", () => {
  beforeEach(() => {
    for (const n of [5, 6, 9]) gh.labels.set(n, new Set(["agent:pr-open"]));
  });

  test("REQ-001-53 starting a Review labels the PR agent:reviewing, like its issues", async () => {
    await reviewer.start("octo/app", 9, [item(5), item(6)], "h1");
    for (const n of [5, 6, 9]) expect(gh.agentLabels(n)).toEqual(["agent:reviewing"]);
  });

  test("REQ-001-53 a Review with findings labels the PR agent:in-progress, like its issues", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5), item(6)], "h1");
    finish(id, [finding()]);
    await reviewer.sync(id);
    for (const n of [5, 6, 9]) expect(gh.agentLabels(n)).toEqual(["agent:in-progress"]);
  });

  test("REQ-001-53 a Review without findings labels the PR agent:reviewed alone", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5), item(6)], "h1");
    finish(id, []);
    await reviewer.sync(id);
    for (const n of [5, 6, 9]) expect(gh.agentLabels(n)).toEqual(["agent:reviewed"]);
  });

  test("REQ-001-53 a Reviewer that gave up on its Result labels the PR agent:failed", async () => {
    const id = await reviewer.start("octo/app", 9, [item(5), item(6)], "h1");
    store.patchSession(id, { state: "idle", needsSync: true, resultFailures: 3 });
    await reviewer.sync(id);
    for (const n of [5, 6, 9]) expect(gh.agentLabels(n)).toEqual(["agent:failed"]);
  });
});
