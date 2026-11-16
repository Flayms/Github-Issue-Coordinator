import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import type { Item } from "../src/github/client.ts";
import { Implementer } from "../src/implementer.ts";
import type { StartOptions } from "../src/runner.ts";
import { Store } from "../src/store.ts";

const config = parseConfig({
  owner: { login: "octo", id: 42 },
  github: { appId: 7, privateKeyPath: "/k.pem" },
  roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app" }],
});

const item = (number: number, extra: Partial<Item> = {}): Item => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  author: { login: "octo", id: 42 },
  labels: ["agent:approved"],
  isPullRequest: false,
  createdAt: "c",
  updatedAt: "u",
  ...extra,
});

class FakeGitHub {
  calls: unknown[][] = [];
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
  async createPull(_r: string, pr: { title: string; body: string; head: string; base: string }) {
    this.calls.push(["createPull", pr]);
    return 77;
  }
  async updatePull(_r: string, pr: number, patch: { title?: string; body?: string }) {
    this.calls.push(["updatePull", pr, patch]);
  }
  async setDraft(_r: string, pr: number, draft: boolean) {
    this.calls.push(["setDraft", pr, draft]);
  }
  of(name: string) {
    return this.calls.filter((c) => c[0] === name);
  }
}

class FakeWorktrees {
  async fetchBase() {}
  created: [string, number[], string][] = [];
  pushed: string[] = [];
  removed: string[] = [];
  ahead = 0;
  room = true;
  headSha = "h1";
  head() {
    return this.headSha;
  }
  hasRoom() {
    return this.room;
  }
  async attach(_repo: string, issues: number[], branch: string) {
    return { path: `/wt/${issues[0]}`, branch };
  }
  async create(repo: string, issues: number[], title: string) {
    this.created.push([repo, issues, title]);
    return { path: `/wt/${issues[0]}`, branch: `agent/${issues[0]}-x` };
  }
  async push(_repo: string, _path: string, branch: string) {
    this.pushed.push(branch);
  }
  commitsAhead() {
    return this.ahead;
  }
  currentBranch(path: string) {
    return `agent/${path.split("/").pop()}-x`;
  }
  defaultBranch() {
    return "main";
  }
  remove(path: string) {
    this.removed.push(path);
  }
}

class FakeRunner {
  started: StartOptions[] = [];
  resumed: [number, string][] = [];
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
  resume(id: number, prompt: string) {
    this.resumed.push([id, prompt]);
    this.store.patchSession(id, { state: "running" });
  }
  close(id: number) {
    const s = this.store.session(id);
    if (s?.state === "running") throw new Error("busy");
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
let impl: Implementer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "impl-"));
  store = new Store(":memory:");
  gh = new FakeGitHub();
  wt = new FakeWorktrees();
  runner = new FakeRunner(store, dir);
  impl = new Implementer({ config, store, gh, runner, worktrees: wt });
  store.updateIssue("octo/app", 5, {
    approvedAt: "a",
    approvalNotes: "keep it small",
    assessment: JSON.stringify({
      issue: 5,
      verdict: "proposed",
      approach: "Add a toggle",
      bundleWith: [6],
      blockedBy: [],
      questions: [],
    }),
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true });
});

const finish = (
  id: number,
  result: unknown = { prTitle: "Dark mode", prBody: "Adds a toggle.", summary: "Did it" },
) => {
  writeFileSync(join(runner.sessionDir(id), "result.json"), JSON.stringify(result));
  store.patchSession(id, { state: "idle", needsSync: true });
};

describe("Implementer run", () => {
  test("REQ-001-06 / REQ-001-09 / REQ-001-33 labels the Bundle in progress and starts a fresh session in one new Worktree", async () => {
    const id = await impl.start("octo/app", [item(5), item(6)]);
    expect(wt.created).toEqual([["octo/app", [5, 6], "Issue 5"]]);
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:in-progress"]],
      ["addLabels", 6, ["agent:in-progress"]],
    ]);
    expect(
      gh
        .of("removeLabel")
        .filter((c) => c[1] === 5)
        .map((c) => c[2]),
    ).toEqual(["agent:approved", "agent:proposed", "agent:blocked"]);
    expect(runner.started).toEqual([
      expect.objectContaining({
        role: "implementer",
        kind: "issue",
        issues: [5, 6],
        title: "Issue 5",
        cwd: "/wt/5",
        model: { model: "sonnet" },
        sandboxDomains: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
      }),
    ]);
    expect(store.issue("octo/app", 6).worktreePath).toBe("/wt/5");
    expect(store.session(id)?.role).toBe("implementer");
  });

  test("REQ-001-09 the context is limited to the issues, the approved Assessment, the notes and the Coordination notes", async () => {
    await impl.start("octo/app", [item(5), item(6)]);
    const prompt = runner.started[0]?.prompt ?? "";
    expect(prompt).toContain("### #5 Issue 5");
    expect(prompt).toContain("Body of 6");
    expect(prompt).toContain("Add a toggle");
    expect(prompt).toContain("keep it small");
    expect(prompt).toContain("#5, #6 are implemented together");
    expect(prompt).toContain("agent/5-x");
  });

  test("REQ-001-09 / REQ-001-29 when the turn ends, pushes the branch and opens a PR with the agent note that closes every issue", async () => {
    const id = await impl.start("octo/app", [item(5), item(6)]);
    store.setModelId(id, "claude-sonnet-5-5");
    gh.calls = [];
    wt.ahead = 2;
    finish(id);
    await impl.sync(id);
    expect(wt.pushed).toEqual(["agent/5-x"]);
    const [, pr] = gh.of("createPull")[0] as [string, { title: string; body: string; head: string; base: string }];
    expect(pr.title).toBe("Dark mode");
    expect(pr.head).toBe("agent/5-x");
    expect(pr.base).toBe("main");
    expect(pr.body).toStartWith("> [!Note]\n> 🤖 Claude Sonnet 5.5 (Implementer) writing on behalf of octo\n");
    expect(pr.body).toContain("Adds a toggle.");
    expect(pr.body).toContain("Closes #5\nCloses #6");
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:pr-open"]],
      ["addLabels", 6, ["agent:pr-open"]],
    ]);
    expect(gh.of("removeLabel")).toEqual([
      ["removeLabel", 5, "agent:in-progress"],
      ["removeLabel", 6, "agent:in-progress"],
    ]);
    expect(store.issue("octo/app", 6).prNumber).toBe(77);
    expect(store.session(id)?.needsSync).toBe(false);
  });

  test("REQ-001-19 later turns, including the Owner's, push new commits and update the PR body", async () => {
    const id = await impl.start("octo/app", [item(5)]);
    wt.ahead = 1;
    finish(id);
    await impl.sync(id);
    gh.calls = [];
    finish(id, { prTitle: "Dark mode", prBody: "Adds a toggle and a test.", summary: "Owner asked for a test" });
    await impl.sync(id);
    expect(wt.pushed).toHaveLength(2);
    expect(gh.of("createPull")).toEqual([]);
    expect(gh.of("updatePull")).toEqual([
      ["updatePull", 77, { title: "Dark mode", body: expect.stringContaining("and a test") }],
    ]);
  });

  test("a turn that ends without any commit and without a PR reports the summary and labels agent:failed", async () => {
    const id = await impl.start("octo/app", [item(5)]);
    gh.calls = [];
    finish(id, { prTitle: "-", prBody: "-", summary: "The Assessment is wrong: the API does not exist." });
    await impl.sync(id);
    expect(wt.pushed).toEqual([]);
    expect(gh.of("createComment")[0]?.[2]).toContain("the API does not exist");
    expect(gh.of("addLabels")).toEqual([["addLabels", 5, ["agent:failed"]]]);
    expect(runner.closed).toEqual([id]);
  });

  test("REQ-001-21 a session that gave up on its Result labels the Bundle agent:failed", async () => {
    const id = await impl.start("octo/app", [item(5), item(6)]);
    gh.calls = [];
    store.patchSession(id, { state: "idle", needsSync: true, resultFailures: 3 });
    await impl.sync(id);
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:failed"]],
      ["addLabels", 6, ["agent:failed"]],
    ]);
  });

  const withPr = async () => {
    const id = await impl.start("octo/app", [item(5)]);
    store.setClaudeSessionId(id, "claude-1");
    wt.ahead = 1;
    finish(id);
    await impl.sync(id);
    gh.calls = [];
    return id;
  };

  test("REQ-001-11 a Feedback round resumes the Implementer session in its Worktree with the feedback", async () => {
    const id = await withPr();
    await impl.feedbackRound("octo/app", 77, [5], "Blocking: crash on empty input");
    expect(runner.resumed).toEqual([[id, expect.stringContaining("crash on empty input")]]);
    expect(gh.of("addLabels")).toEqual([["addLabels", 5, ["agent:in-progress"]]]);
    expect(gh.of("removeLabel").map((c) => [c[1], c[2]])).toEqual([
      [5, "agent:pr-open"],
      [5, "agent:reviewed"],
      [5, "agent:failed"],
      [77, "agent:reviewed"],
      [77, "agent:failed"],
    ]);
  });

  test("REQ-001-11 / REQ-001-33 a Feedback round without a resumable session starts a fresh one in the existing Worktree", async () => {
    const id = await impl.start("octo/app", [item(5)]); // never reported a Claude session id
    wt.ahead = 1;
    finish(id);
    await impl.sync(id);
    const fresh = await impl.feedbackRound("octo/app", 77, [5], "Fix it");
    expect(fresh).not.toBe(id);
    expect(runner.started.at(-1)).toMatchObject({
      role: "implementer",
      issues: [5],
      title: "Issue 5",
      cwd: "/wt/5",
      sandboxDomains: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
    });
    expect(runner.started.at(-1)?.prompt).toContain("Fix it");
  });

  test("REQ-001-11 the sync after a Feedback round pushes, updates the PR and returns the issue to agent:pr-open", async () => {
    const id = await withPr();
    await impl.feedbackRound("octo/app", 77, [5], "Fix it");
    gh.calls = [];
    finish(id);
    await impl.sync(id);
    expect(gh.of("updatePull")).toHaveLength(1);
    expect(gh.of("addLabels")).toEqual([["addLabels", 5, ["agent:pr-open"]]]);
    expect(gh.of("removeLabel")).toEqual([["removeLabel", 5, "agent:in-progress"]]);
  });

  test("REQ-001-31 a push of a new head after the PR was reviewed converts it back to draft", async () => {
    const id = await withPr();
    store.updateIssue("octo/app", 5, { reviewedHeadSha: "h1" });
    await impl.feedbackRound("octo/app", 77, [5], "/agent add a test");
    gh.calls = [];
    wt.headSha = "h2";
    finish(id);
    await impl.sync(id);
    expect(gh.of("setDraft")).toEqual([["setDraft", 77, true]]);
  });

  test("REQ-001-31 a turn that pushes nothing new leaves a reviewed PR ready", async () => {
    const id = await withPr();
    store.updateIssue("octo/app", 5, { reviewedHeadSha: "h1" });
    finish(id, { prTitle: "Dark mode", prBody: "Adds a toggle.", summary: "Answered a question" });
    await impl.sync(id);
    expect(gh.of("setDraft")).toEqual([]);
  });

  const reviewed = (findings: unknown[]) => {
    for (const n of [5])
      store.updateIssue("octo/app", n, { reviewedHeadSha: "h1", reviewFindings: JSON.stringify(findings) });
  };
  const crash = { path: "src/a.ts", line: 3, severity: "high", body: "Crashes on empty input" };
  const naming = { path: "src/b.ts", line: 9, severity: "medium", body: "Breaks the naming convention\nsee AGENTS.md" };
  const answered = (responses: unknown[]) => ({
    prTitle: "Dark mode",
    prBody: "Adds a toggle.",
    summary: "Fixed it",
    responses,
  });

  test("REQ-001-35 the sync after a round on Review findings posts the answers as one PR comment, each finding quoted next to its answer", async () => {
    const id = await withPr();
    store.setModelId(id, "claude-opus-5-5");
    reviewed([crash, naming]);
    await impl.feedbackRound("octo/app", 77, [5], "Review findings");
    gh.calls = [];
    wt.headSha = "h2";
    finish(
      id,
      answered([
        { finding: 1, answer: "fixed", reason: "Added a guard and a test" },
        { finding: 2, answer: "declined", reason: "The name is in the glossary" },
      ]),
    );
    await impl.sync(id);
    const comments = gh.of("createComment");
    expect(comments).toHaveLength(1);
    const [, pr, body] = comments[0] as [string, number, string];
    expect(pr).toBe(77);
    expect(body).toStartWith("> [!Note]\n> 🤖 Claude Opus 5.5 (Implementer) writing on behalf of octo\n");
    expect(body).toContain("## Answers to the Review findings");
    expect(body).toContain(
      "1. **high** `src/a.ts:3`\n\n   > Crashes on empty input\n\n   **Fixed**: Added a guard and a test",
    );
    expect(body).toContain(
      "   > Breaks the naming convention\n   > see AGENTS.md\n\n   **Declined**: The name is in the glossary",
    );
    expect(body).not.toContain("waits for the Owner");
    const rec = store.issue("octo/app", 5);
    expect(rec.reviewFindings).toBeNull();
    expect(rec.reviewHistory).toContain("**Declined**: The name is in the glossary");
    expect(rec.reviewHistory).toContain("Crashes on empty input");
  });

  test("REQ-001-36 answers of later rounds are added to the history", async () => {
    const id = await withPr();
    store.updateIssue("octo/app", 5, { reviewHistory: "Earlier round" });
    reviewed([crash]);
    await impl.feedbackRound("octo/app", 77, [5], "Review findings");
    wt.headSha = "h2";
    finish(id, answered([{ finding: 1, answer: "fixed", reason: "Guarded" }]));
    await impl.sync(id);
    const history = store.issue("octo/app", 5).reviewHistory ?? "";
    expect(history).toStartWith("Earlier round");
    expect(history).toContain("Guarded");
  });

  test("REQ-001-35 a round whose Result leaves a finding unanswered is not synced", async () => {
    const id = await withPr();
    reviewed([crash, naming]);
    await impl.feedbackRound("octo/app", 77, [5], "Review findings");
    gh.calls = [];
    finish(id, answered([{ finding: 1, answer: "fixed", reason: "Guarded" }]));
    await impl.sync(id);
    expect(gh.of("createComment")).toEqual([]);
    expect(gh.of("updatePull")).toEqual([]);
  });

  test("REQ-001-31 / REQ-001-35 a round that declines every finding without new commits stays draft at agent:pr-open and says it waits for the Owner", async () => {
    const id = await withPr();
    reviewed([crash]);
    await impl.feedbackRound("octo/app", 77, [5], "Review findings", { headSha: "h1", causes: ["findings"] });
    gh.calls = [];
    finish(id, answered([{ finding: 1, answer: "declined", reason: "Input is never empty here" }]));
    await impl.sync(id);
    expect(gh.of("setDraft")).toEqual([]);
    expect(gh.of("addLabels")).toEqual([["addLabels", 5, ["agent:pr-open"]]]);
    const comments = gh.of("createComment");
    expect(comments).toHaveLength(1); // REQ-001-38: the stall is part of the answers comment, not a second one
    const [, , body] = comments[0] as [string, number, string];
    expect(body).toContain("**Declined**: Input is never empty here");
    expect(body).toContain("No new commits in this round");
    expect(body).toContain("the Review findings were declined or not fixed");
    expect(body).toContain("`/agent <text>`");
    expect(store.issue("octo/app", 5)).toMatchObject({ inFeedbackRound: 0, autoRound: null });
  });

  test("REQ-001-38 an automatic round on checks or conflicts that ends without new commits tells the Owner why, once", async () => {
    const id = await withPr();
    await impl.feedbackRound("octo/app", 77, [5], "Failing checks and conflicts", {
      headSha: "h1",
      causes: ["checks", "conflicts"],
    });
    gh.calls = [];
    finish(id);
    await impl.sync(id);
    expect(gh.of("setDraft")).toEqual([]);
    expect(gh.of("addLabels")).toEqual([["addLabels", 5, ["agent:pr-open"]]]);
    const comments = gh.of("createComment");
    expect(comments).toHaveLength(1);
    const [, pr, body] = comments[0] as [string, number, string];
    expect(pr).toBe(77);
    expect(body).toStartWith("> [!Note]\n> 🤖");
    expect(body).toContain("No new commits in this round");
    expect(body).toContain("the checks still fail");
    expect(body).toContain("the PR still has merge conflicts with its base branch");
    expect(body).toContain("`/agent <text>`");
    expect(body).toContain("mark it ready for review");
    finish(id); // e.g. a later chat turn with the Owner
    gh.calls = [];
    await impl.sync(id);
    expect(gh.of("createComment")).toEqual([]);
  });

  test("REQ-001-38 an automatic round that pushes a new head posts no stall comment", async () => {
    const id = await withPr();
    await impl.feedbackRound("octo/app", 77, [5], "Failing checks", { headSha: "h1", causes: ["checks"] });
    gh.calls = [];
    wt.headSha = "h2";
    finish(id);
    await impl.sync(id);
    expect(gh.of("createComment")).toEqual([]);
  });

  test("REQ-001-35 a round without Review findings (e.g. failing checks) posts no answers comment", async () => {
    const id = await withPr();
    await impl.feedbackRound("octo/app", 77, [5], "Failing checks");
    gh.calls = [];
    finish(id);
    await impl.sync(id);
    expect(gh.of("createComment")).toEqual([]);
  });

  test("REQ-001-14 cleanup removes the Worktree, closes the sessions, clears the agent labels and the PR on record", async () => {
    const id = await impl.start("octo/app", [item(5), item(6)]);
    store.patchSession(id, { state: "idle" });
    for (const n of [5, 6]) store.updateIssue("octo/app", n, { prNumber: 77 });
    gh.calls = [];
    expect(await impl.cleanup("octo/app", [5, 6], "/wt/5")).toBe(true);
    expect(wt.removed).toEqual(["/wt/5"]);
    expect(runner.closed).toEqual([id]);
    expect(
      gh
        .of("removeLabel")
        .filter((c) => c[1] === 6)
        .map((c) => c[2]),
    ).toEqual(["agent:in-progress", "agent:pr-open", "agent:reviewing", "agent:reviewed", "agent:failed"]);
    expect(store.issue("octo/app", 5).worktreePath).toBeNull();
    expect([5, 6].map((n) => store.issue("octo/app", n).prNumber)).toEqual([null, null]);
  });

  test("REQ-001-41 re-attaching records the PR and Worktree, replaces every other agent label with agent:pr-open and says so on the PR", async () => {
    store.updateIssue("octo/app", 5, { inFeedbackRound: 1, pendingFeedback: "old", reviewFindings: "[]" });
    expect(await impl.reattach("octo/app", 34, "agent/5-x", [5, 6])).toBe("/wt/5");
    for (const n of [5, 6]) {
      expect(store.issue("octo/app", n)).toMatchObject({
        worktreePath: "/wt/5",
        prNumber: 34,
        inFeedbackRound: 0,
        pendingFeedback: null,
        reviewFindings: null,
      });
      expect(
        gh
          .of("removeLabel")
          .filter((c) => c[1] === n)
          .map((c) => c[2]),
      ).toEqual([
        "agent:proposed",
        "agent:needs-refinement",
        "agent:wontfix-proposed",
        "agent:approved",
        "agent:blocked",
        "agent:planning",
        "agent:in-progress",
        "agent:reviewing",
        "agent:reviewed",
        "agent:failed",
      ]);
    }
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", 5, ["agent:pr-open"]],
      ["addLabels", 6, ["agent:pr-open"]],
    ]);
    expect(gh.of("removeLabel").filter((c) => c[1] === 34)).toEqual([
      ["removeLabel", 34, "agent:reviewed"],
      ["removeLabel", 34, "agent:failed"],
    ]);
    const comments = gh.of("createComment");
    expect(comments).toEqual([["createComment", 34, expect.stringContaining("re-attached this PR")]]);
    expect(comments[0]?.[2]).toStartWith("> [!Note]\n> 🤖 Coordinator writing on behalf of");
    expect(comments[0]?.[2]).toContain("`agent/5-x`");
  });

  test("REQ-001-19 cleanup waits while the Owner is chatting with the session", async () => {
    await impl.start("octo/app", [item(5)]);
    expect(await impl.cleanup("octo/app", [5], "/wt/5")).toBe(false);
    expect(wt.removed).toEqual([]);
  });
});
