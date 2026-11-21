import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import type { Comment, Item, ItemHistory } from "../src/github/client.ts";
import { GitHubError } from "../src/github/http.ts";
import {
  bodyHash,
  findLinks,
  isCommand,
  Planner,
  renderAssessment,
  renderContext,
  renderLinkedHistory,
} from "../src/planner.ts";
import type { PlannerResult } from "../src/results.ts";
import type { StartOptions } from "../src/runner.ts";
import { Store } from "../src/store.ts";

const config = parseConfig({
  owner: { login: "octo", id: 42 },
  roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app" }],
});

const item = (number: number, extra: Partial<Item> = {}): Item => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  author: { login: "octo", id: 42 },
  labels: [],
  isPullRequest: false,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  ...extra,
});

const comment = (id: number, body: string): Comment => ({
  id,
  body,
  author: { login: "octo", id: 42 },
  createdAt: "c",
  updatedAt: "c",
});

const none = { issues: [] as Item[], pulls: [] as Item[] };

const entry = (issue: number, extra: Partial<PlannerResult[number]> = {}): PlannerResult[number] => ({
  issue,
  verdict: "proposed",
  approach: `Approach for ${issue}`,
  bundleWith: [],
  blockedBy: [],
  questions: [],
  splitOff: [],
  ...extra,
});

class FakeGitHub {
  calls: unknown[][] = [];
  private nextId = 100;
  deleted = new Set<number>();
  private nextIssue = 200;
  async createIssue(repo: string, issue: { title: string; body: string }) {
    this.calls.push(["createIssue", repo, issue]);
    return this.nextIssue++;
  }
  async addLabels(repo: string, issue: number, labels: string[]) {
    this.calls.push(["addLabels", repo, issue, labels]);
  }
  async removeLabel(repo: string, issue: number, label: string) {
    this.calls.push(["removeLabel", repo, issue, label]);
    return true;
  }
  failCreateComment = 0;
  async createComment(repo: string, issue: number, body: string) {
    this.calls.push(["createComment", repo, issue, body]);
    if (this.failCreateComment-- > 0)
      throw new GitHubError(502, "POST", `/repos/${repo}/issues/${issue}/comments`, "Bad Gateway");
    return this.nextId++;
  }
  async updateComment(repo: string, id: number, body: string) {
    this.calls.push(["updateComment", repo, id, body]);
    if (this.deleted.has(id)) throw new GitHubError(404, "PATCH", `/repos/${repo}/issues/comments/${id}`, "Not Found");
  }
  /** Linked history per item (REQ-001-47); items not listed fail to fetch. */
  histories = new Map<number, ItemHistory>();
  async itemHistory(repo: string, n: number) {
    this.calls.push(["itemHistory", repo, n]);
    const h = this.histories.get(n);
    if (!h) throw new GitHubError(404, "GET", `/repos/${repo}/issues/${n}`, "Not Found");
    return h;
  }
  of(name: string) {
    return this.calls.filter((c) => c[0] === name);
  }
}

class FakeWorktrees {
  published: { repo: string; folder: string; names: string[]; message: string }[] = [];
  fail = false;
  async publishImages(repo: string, folder: string, files: { name: string; data: Uint8Array }[], message: string) {
    if (this.fail) throw new Error("push rejected");
    this.published.push({ repo, folder, names: files.map((f) => f.name), message });
    return "c0ffee";
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
let runner: FakeRunner;
let planner: Planner;
let worktrees: FakeWorktrees;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "planner-"));
  store = new Store(":memory:");
  gh = new FakeGitHub();
  runner = new FakeRunner(store, dir);
  worktrees = new FakeWorktrees();
  planner = new Planner({ config, store, gh, runner, worktrees });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true });
});

const finishTurn = (id: number, result: unknown) => {
  writeFileSync(join(runner.sessionDir(id), "result.json"), JSON.stringify(result));
  store.patchSession(id, { state: "idle", needsSync: true });
};

describe("Assessment comment", () => {
  test("REQ-001-02 shows the agent note, verdict, approach, questions and Coordination notes", () => {
    const text = renderAssessment(entry(5, { questions: ["Which API?"], bundleWith: [6], blockedBy: [7] }), "NOTE");
    expect(text).toStartWith("NOTE\n");
    expect(text).toContain("## Assessment: proposed");
    expect(text).toContain("Approach for 5");
    expect(text).toContain("- Which API?");
    expect(text).toContain("- Do together with #6");
    expect(text).toContain("- Blocked by #7");
    expect(text).toContain("/approve");
  });

  test("REQ-001-34 lists the Split-off issues under Coordination", () => {
    const text = renderAssessment(entry(5), "NOTE", [{ number: 31, title: "Fix the parser" }]);
    expect(text).toContain("**Coordination**");
    expect(text).toContain("- Split off #31");
  });

  test("leaves out empty sections", () => {
    const text = renderAssessment(entry(5, { verdict: "wontfix-proposed" }), "NOTE");
    expect(text).toContain("## Assessment: won't fix (proposed)");
    expect(text).not.toContain("Questions");
    expect(text).not.toContain("Coordination");
  });

  test("REQ-001-02 the Planner context lists the issues to assess and all open issues and PRs", () => {
    const text = renderContext({
      assess: [item(5, { body: "x".repeat(10_000) })],
      issues: [item(5), item(6, { labels: ["agent:proposed"] })],
      pulls: [item(9, { isPullRequest: true, title: "Fix" })],
    });
    expect(text).toContain("### #5 Issue 5");
    expect(text).toContain("- #6 Issue 6 [agent:proposed]");
    expect(text).toContain("- #9 Fix");
    expect(text.length).toBeLessThan(8_000);
  });

  test("commands are not plan feedback", () => {
    expect(isCommand("/approve ship it")).toBe(true);
    expect(isCommand("  /agent fix tests")).toBe(true);
    expect(isCommand("/wake")).toBe(true);
    expect(isCommand("Please also handle /approve in docs")).toBe(false);
    expect(isCommand("/approved is a word")).toBe(false);
  });
});

describe("Planner pass", () => {
  test("REQ-001-02 labels the issues agent:planning and starts one batch Planner session over all of them", async () => {
    const id = await planner.startPass("octo/app", "/clones/app", [item(5), item(6)], {
      issues: [item(5), item(6)],
      pulls: [],
    });
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", "octo/app", 5, ["agent:planning"]],
      ["addLabels", "octo/app", 6, ["agent:planning"]],
    ]);
    expect(runner.started).toEqual([
      expect.objectContaining({
        repo: "octo/app",
        role: "planner",
        kind: "batch",
        issues: [5, 6],
        cwd: "/clones/app",
        model: { model: "opus" },
      }),
    ]);
    expect(runner.started[0]?.prompt).toContain("### #6 Issue 6");
    expect(store.session(id)?.kind).toBe("batch");
    expect(store.issue("octo/app", 5).bodyHash).toBe(bodyHash("Body of 5"));
  });

  test("REQ-002-17 a started Planner session's prompt has the repository's Extra instructions, read from the live config", async () => {
    const withExtra = parseConfig({
      owner: { login: "octo", id: 42 },
      roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
      repos: [{ name: "octo/app", instructions: { planner: "Always answer in German." } }, { name: "octo/web" }],
    });
    let current = config;
    planner = new Planner({
      get config() {
        return current;
      },
      store,
      gh,
      runner,
      worktrees,
    });
    await planner.startPass("octo/app", "/clones/app", [item(5)], none);
    expect(runner.started.at(-1)?.prompt).not.toContain("German");
    current = withExtra;
    await planner.startPass("octo/app", "/clones/app", [item(6)], none);
    const prompt = runner.started.at(-1)?.prompt as string;
    expect(prompt).toContain("## Additional instructions from the Owner\n\n");
    expect(prompt.trimEnd().endsWith("Always answer in German.")).toBe(true);
    await planner.startPass("octo/web", "/clones/web", [item(7)], none);
    expect(runner.started.at(-1)?.prompt).not.toContain("German");
  });

  test("REQ-001-02 posts one Assessment per issue, sets the verdict label, and closes the batch session", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5), item(6)], { issues: [], pulls: [] });
    gh.calls = [];
    finishTurn(id, [entry(5), entry(6, { verdict: "needs-refinement", questions: ["?"] })]);
    await planner.sync(id);
    expect(gh.of("createComment").map((c) => c[2])).toEqual([5, 6]);
    expect(gh.of("addLabels")).toEqual([
      ["addLabels", "octo/app", 5, ["agent:proposed"]],
      ["addLabels", "octo/app", 6, ["agent:needs-refinement"]],
    ]);
    expect(
      gh
        .of("removeLabel")
        .filter((c) => c[2] === 5)
        .map((c) => c[3]),
    ).toEqual(["agent:planning", "agent:needs-refinement", "agent:wontfix-proposed"]);
    expect(store.issue("octo/app", 5).assessmentCommentId).toBe(100);
    expect(JSON.parse(store.issue("octo/app", 6).assessment ?? "{}").verdict).toBe("needs-refinement");
    expect(runner.closed).toEqual([id]);
    expect(store.session(id)?.needsSync).toBe(false);
  });

  test("REQ-001-29 the Assessment's note names the session's model and the Planner Role", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], { issues: [], pulls: [] });
    store.setModelId(id, "claude-opus-5-5");
    gh.calls = [];
    finishTurn(id, [entry(5)]);
    await planner.sync(id);
    expect(gh.of("createComment")[0]?.[3]).toStartWith(
      "> [!Note]\n> 🤖 Claude Opus 5.5 (Planner) writing on behalf of octo\n",
    );
  });

  test("REQ-001-21 a session that gave up on its Result labels its issues agent:failed", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], { issues: [], pulls: [] });
    gh.calls = [];
    store.patchSession(id, { state: "idle", needsSync: true, resultFailures: 3 });
    await planner.sync(id);
    expect(gh.of("addLabels")).toEqual([["addLabels", "octo/app", 5, ["agent:failed"]]]);
    expect(gh.of("removeLabel")).toEqual([["removeLabel", "octo/app", 5, "agent:planning"]]);
    expect(gh.of("createComment")[0]?.[3]).toContain("could not produce a valid Assessment");
    expect(runner.closed).toEqual([id]);
  });

  test("REQ-003-15 an Assessment records one Event with its verdict; a session that gave up records a failure", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], { issues: [], pulls: [] });
    finishTurn(id, [entry(5)]);
    await planner.sync(id);
    expect(store.events().map((e) => [e.kind, e.issues, e.text])).toEqual([
      ["assessed", [5], "Assessment of #5: proposed"],
    ]);

    const again = await planner.startPass("octo/app", "/c", [item(6)], { issues: [], pulls: [] });
    store.patchSession(again, { state: "idle", needsSync: true, resultFailures: 3 });
    await planner.sync(again);
    expect(store.events()[0]).toMatchObject({
      kind: "failed",
      issues: [6],
      text: "#6 failed: the Planner could not produce a valid Assessment",
    });
  });
});

describe("plan revision", () => {
  const assessmentsPosted = () => gh.of("createComment").filter((c) => String(c[3]).includes("## Assessment"));
  const assessed = async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], { issues: [], pulls: [] });
    finishTurn(id, [entry(5)]);
    await planner.sync(id);
    gh.calls = [];
    return id;
  };

  test("REQ-001-03 / REQ-001-33 after a batch, feedback goes to a fresh Planner session for that issue with its current Assessment", async () => {
    const batch = await assessed();
    store.setAgentSessionId(batch, "sess-batch"); // resumable, but it covers several issues
    await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "Use the v2 API")], bodyChanged: false },
      none,
    );
    expect(runner.started.at(-1)).toMatchObject({ kind: "issue", issues: [5], role: "planner", title: "Issue 5" });
    expect(runner.started.at(-1)?.prompt).toContain("Approach for 5");
    expect(runner.started.at(-1)?.prompt).toContain("Use the v2 API");
    expect(store.issue("octo/app", 5).lastHandledCommentId).toBe(300);
  });

  test("REQ-001-03 a later comment resumes that issue's own Planner session", async () => {
    await assessed();
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    store.setAgentSessionId(own, "sess-own");
    store.patchSession(own, { state: "idle" });
    const again = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(301, "b")], bodyChanged: false },
      none,
    );
    expect(again).toBe(own);
    expect(runner.resumed).toEqual([[own, expect.stringContaining("b")]]);
    expect(store.issue("octo/app", 5).lastHandledCommentId).toBe(301);
  });

  test("REQ-001-03 the revised Assessment edits the existing comment in place and updates the label", async () => {
    await assessed();
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    finishTurn(own, [entry(5, { verdict: "wontfix-proposed", approach: "Not worth it" })]);
    await planner.sync(own);
    expect(assessmentsPosted()).toEqual([]); // the Reply (REQ-001-40) is the only new comment
    expect(gh.of("updateComment")).toEqual([
      ["updateComment", "octo/app", 100, expect.stringContaining("Not worth it")],
    ]);
    expect(gh.of("addLabels")).toEqual([["addLabels", "octo/app", 5, ["agent:wontfix-proposed"]]]);
    expect(runner.closed).not.toContain(own);
  });

  test("REQ-001-32 a deleted Assessment comment is posted again and edited from then on", async () => {
    await assessed();
    gh.deleted.add(100); // the Owner deleted the Assessment comment
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    finishTurn(own, [entry(5, { approach: "v2" })]);
    await planner.sync(own);
    expect(assessmentsPosted()).toEqual([["createComment", "octo/app", 5, expect.stringContaining("v2")]]);
    expect(store.issue("octo/app", 5).assessmentCommentId).toBe(101);
    expect(gh.of("addLabels")).toEqual([["addLabels", "octo/app", 5, ["agent:proposed"]]]);
    gh.calls = [];
    finishTurn(own, [entry(5, { approach: "v3" })]);
    await planner.sync(own);
    expect(gh.of("updateComment")).toEqual([["updateComment", "octo/app", 101, expect.stringContaining("v3")]]);
  });

  test("REQ-001-19 a turn the Owner started is synced too, and an unchanged Result touches nothing on GitHub", async () => {
    await assessed();
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    finishTurn(own, [entry(5, { approach: "v2" })]);
    await planner.sync(own);
    gh.calls = [];
    store.patchSession(own, { needsSync: true }); // e.g. the Owner chatted from the phone; same Result
    await planner.sync(own);
    expect(gh.calls).toEqual([]);
    finishTurn(own, [entry(5, { approach: "v3 after chatting" })]);
    await planner.sync(own);
    expect(gh.of("updateComment")).toEqual([
      ["updateComment", "octo/app", 100, expect.stringContaining("v3 after chatting")],
    ]);
  });
});

describe("replies to the Owner's comments", () => {
  const ASSESSMENT_URL = "https://github.com/octo/app/issues/5#issuecomment-100";
  const commentUrl = (id: number) => `https://github.com/octo/app/issues/5#issuecomment-${id}`;
  const assessed = async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], { issues: [], pulls: [] });
    store.setModelId(id, "claude-opus-5-5");
    finishTurn(id, [entry(5)]);
    await planner.sync(id);
    gh.calls = [];
    return id;
  };
  const replies = () => gh.of("createComment");

  test("REQ-001-40 a revision a comment started edits the Assessment and posts one reply that links the comment and the Assessment", async () => {
    await assessed();
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "Use v2")], bodyChanged: false },
      none,
    );
    expect(runner.started.at(-1)?.prompt).toContain("reply");
    store.setModelId(own, "claude-opus-5-5");
    finishTurn(own, [entry(5, { approach: "v2", reply: "Switched to the v2 API, as you asked." })]);
    await planner.sync(own);
    expect(gh.of("updateComment")).toEqual([["updateComment", "octo/app", 100, expect.stringContaining("v2")]]);
    expect(replies()).toEqual([["createComment", "octo/app", 5, expect.any(String)]]);
    const reply = replies()[0]?.[3] as string;
    expect(reply).toStartWith("> [!Note]\n> 🤖 Claude Opus 5.5 (Planner) writing on behalf of octo\n");
    expect(reply).toContain(commentUrl(300));
    expect(reply).toContain(ASSESSMENT_URL);
    expect(reply).toContain("Switched to the v2 API, as you asked.");
    expect(store.issue("octo/app", 5).replyTo).toEqual([]);
  });

  test("REQ-001-40 the reply is posted even when the Assessment did not change, and links every comment of the turn", async () => {
    await assessed();
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "Why not v1?"), comment(301, "And tests?")], bodyChanged: false },
      none,
    );
    finishTurn(own, [entry(5, { reply: "v1 is deprecated; tests are already planned." })]);
    await planner.sync(own);
    expect(gh.of("updateComment")).toEqual([]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]?.[3]).toContain(commentUrl(300));
    expect(replies()[0]?.[3]).toContain(commentUrl(301));
    expect(replies()[0]?.[3]).toContain("v1 is deprecated");
  });

  test("REQ-001-40 a turn no comment started posts no reply: the Owner chatting, or the first pass", async () => {
    await assessed();
    expect(store.issue("octo/app", 5).replyTo).toEqual([]);
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    finishTurn(own, [entry(5, { approach: "v2", reply: "Done." })]);
    await planner.sync(own);
    gh.calls = [];
    finishTurn(own, [entry(5, { approach: "v3 after chatting", reply: "Done." })]); // the Owner chatted from the phone
    await planner.sync(own);
    expect(gh.of("updateComment")).toHaveLength(1);
    expect(replies()).toEqual([]);
  });

  test("REQ-001-40 a Result without a reply still gets a one-line reply with the links", async () => {
    await assessed();
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    finishTurn(own, [entry(5, { approach: "v2" })]);
    await planner.sync(own);
    const reply = replies()[0]?.[3] as string;
    expect(reply).toContain(commentUrl(300));
    expect(reply).toContain(ASSESSMENT_URL);
    expect(reply).toContain("Took your feedback into account");
  });

  test("REQ-001-40 / REQ-001-27 a failed reply is posted on the retry, and only once", async () => {
    await assessed();
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    finishTurn(own, [entry(5, { approach: "v2", reply: "Done." })]);
    gh.failCreateComment = 1;
    await expect(planner.sync(own)).rejects.toThrow();
    gh.calls = [];
    await planner.sync(own);
    expect(replies()).toHaveLength(1);
    gh.calls = [];
    store.patchSession(own, { needsSync: true });
    await planner.sync(own);
    expect(replies()).toEqual([]);
  });

  test("REQ-001-41 an edited issue is planned from scratch: the live session is closed, a fresh one gets all open issues and PRs but not the old Assessment", async () => {
    await assessed();
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    store.setAgentSessionId(own, "sess-own");
    finishTurn(own, [entry(5, { approach: "Old plan", reply: "ok" })]);
    await planner.sync(own);
    gh.calls = [];
    const fresh = await planner.revise(
      "octo/app",
      "/c",
      item(5, { body: "New body" }),
      { comments: [], bodyChanged: true },
      { issues: [item(5), item(6)], pulls: [item(9, { isPullRequest: true, title: "Fix" })] },
    );
    expect(runner.closed).toContain(own);
    expect(runner.resumed).toEqual([]);
    expect(fresh).not.toBe(own);
    expect(runner.started.at(-1)).toMatchObject({ kind: "issue", issues: [5], title: "Issue 5" });
    const prompt = runner.started.at(-1)?.prompt as string;
    expect(prompt).toContain("New body");
    expect(prompt).toContain("- #6 Issue 6");
    expect(prompt).toContain("- #9 Fix");
    expect(prompt).not.toContain("Old plan");
    expect(prompt).not.toContain("Current Assessment");
    expect(prompt).not.toContain("The Owner's feedback");
    expect(store.issue("octo/app", 5).bodyHash).toBe(bodyHash("New body"));

    finishTurn(fresh, [entry(5, { verdict: "needs-refinement", approach: "New plan", questions: ["?"] })]);
    await planner.sync(fresh);
    expect(gh.of("updateComment")).toEqual([["updateComment", "octo/app", 100, expect.stringContaining("New plan")]]);
    expect(replies()).toEqual([]);
    expect(gh.of("addLabels")).toEqual([["addLabels", "octo/app", 5, ["agent:needs-refinement"]]]);
  });

  test("REQ-001-41 / REQ-001-40 comments from the same poll go into the fresh session as feedback and get a reply", async () => {
    await assessed();
    const fresh = await planner.revise(
      "octo/app",
      "/c",
      item(5, { body: "New body" }),
      { comments: [comment(300, "Also support YAML")], bodyChanged: true },
      none,
    );
    const prompt = runner.started.at(-1)?.prompt as string;
    expect(prompt).toContain("New body");
    expect(prompt).toContain("Also support YAML");
    expect(prompt).not.toContain("Approach for 5");
    expect(store.issue("octo/app", 5).lastHandledCommentId).toBe(300);
    finishTurn(fresh, [entry(5, { approach: "New plan with YAML", reply: "Added YAML." })]);
    await planner.sync(fresh);
    expect(gh.of("updateComment")).toEqual([["updateComment", "octo/app", 100, expect.any(String)]]);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]?.[3]).toContain(commentUrl(300));
  });
});

describe("Split-off issues", () => {
  const split = (title: string) => ({ title, body: `Body: ${title}` });

  test("REQ-001-34 a Planner Result's Split-off issues are created once, with the note and a back-link, and listed in the Assessment", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], { issues: [], pulls: [] });
    store.setModelId(id, "claude-opus-5-5");
    gh.calls = [];
    finishTurn(id, [entry(5, { splitOff: [split("Fix the parser"), split("Docs typo")] })]);
    await planner.sync(id);
    expect(gh.of("createIssue")).toEqual([
      ["createIssue", "octo/app", { title: "Fix the parser", body: expect.any(String) }],
      ["createIssue", "octo/app", { title: "Docs typo", body: expect.any(String) }],
    ]);
    const body = (gh.of("createIssue")[0]?.[2] as { body: string } | undefined)?.body;
    expect(body).toStartWith("> [!Note]\n> 🤖 Claude Opus 5.5 (Planner) writing on behalf of octo\n");
    expect(body).toContain("Split off from #5");
    expect(body).toContain("Body: Fix the parser");
    expect(store.splitOffs("octo/app", 5)).toEqual([
      { number: 200, title: "Fix the parser" },
      { number: 201, title: "Docs typo" },
    ]);
    expect(store.splitOffNumbers("octo/app")).toEqual(new Set([200, 201]));
    const assessment = gh.of("createComment")[0]?.[3] as string;
    expect(assessment).toContain("- Split off #200");
    expect(assessment).toContain("- Split off #201");
  });

  test("REQ-001-34 a revision does not create an already created Split-off issue again, and never drops one", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], { issues: [], pulls: [] });
    finishTurn(id, [entry(5, { splitOff: [split("Fix the parser")] })]);
    await planner.sync(id);
    const own = await planner.revise(
      "octo/app",
      "/c",
      item(5),
      { comments: [comment(300, "a")], bodyChanged: false },
      none,
    );
    gh.calls = [];
    finishTurn(own, [entry(5, { approach: "v2", splitOff: [split(" fix the Parser "), split("Add tests")] })]);
    await planner.sync(own);
    expect(gh.of("createIssue")).toEqual([
      ["createIssue", "octo/app", { title: "Add tests", body: expect.any(String) }],
    ]);
    gh.calls = [];
    finishTurn(own, [entry(5, { approach: "v3" })]); // the Planner no longer lists them
    await planner.sync(own);
    expect(gh.of("createIssue")).toEqual([]);
    const assessment = gh.of("updateComment")[0]?.[3] as string;
    expect(assessment).toContain("- Split off #200");
    expect(assessment).toContain("- Split off #201");
  });
});

const history = (number: number, extra: Partial<ItemHistory> = {}): ItemHistory => ({
  number,
  title: `Linked ${number}`,
  isPullRequest: false,
  state: "open",
  draft: false,
  labels: [],
  events: [],
  reviews: [],
  comments: [],
  ...extra,
});

describe("Linked history", () => {
  test("REQ-001-47 picks #N, same-repo shorthand and URLs in order, once each, and ignores other repositories", () => {
    const text = [
      "Since #47 the PR stays in draft, see https://github.com/octo/app/pull/48 and octo/app#49.",
      "Also https://github.com/OCTO/App/issues/50#issuecomment-1 and #47 again.",
      "Not: other/lib#7, https://github.com/other/lib/pull/8, https://example.com/page#9, &#39; ## Heading, #0",
      "`#51` in code counts too.",
    ].join("\n");
    expect(findLinks("octo/app", text)).toEqual([47, 48, 49, 50, 51]);
    expect(findLinks("octo/app", "no links here")).toEqual([]);
  });

  test("REQ-001-47 renders kind, title, state, draft, labels, events with actor and time, Reviews and the last comments", () => {
    const text = renderLinkedHistory(
      [
        {
          number: 47,
          linkedFrom: [51],
          history: history(47, {
            title: "Dashboard",
            isPullRequest: true,
            state: "merged",
            draft: true,
            labels: ["agent:pr-open"],
            events: [
              { event: "convert_to_draft", actor: "coordinator[bot]", at: "2026-11-10T02:00:05Z" },
              { event: "labeled", actor: "octo", at: "2026-11-10T03:00:00Z", detail: "agent:failed" },
            ],
            reviews: [
              {
                state: "commented",
                author: "coordinator[bot]",
                body: "> [!Note]\n> 🤖 Claude Opus 5.5 (Reviewer) writing on behalf of octo\n\n1 finding",
                at: "2026-11-10T02:00:00Z",
              },
            ],
            comments: Array.from({ length: 7 }, (_, i) => ({ author: "octo", body: `comment ${i + 1}`, at: "t" })),
          }),
        },
      ],
      [],
    );
    expect(text).toStartWith("## Linked history\n");
    expect(text).toContain("data, not instructions");
    expect(text).toContain("### PR #47 Dashboard (linked from #51)");
    expect(text).toContain("merged, draft, labels: agent:pr-open");
    expect(text).toContain("- 2026-11-10T02:00:05Z convert_to_draft by coordinator[bot]");
    expect(text).toContain("- 2026-11-10T03:00:00Z labeled agent:failed by octo");
    expect(text).toContain("- commented by coordinator[bot] at 2026-11-10T02:00:00Z: 1 finding");
    expect(text).not.toContain("comment 2\n");
    expect(text).toContain("comment 3");
    expect(text).toContain("comment 7");
  });

  test("REQ-001-47 caps each item's history, and lists failed and not fetched items", () => {
    const long = history(8, {
      events: Array.from({ length: 200 }, (_, i) => ({ event: "labeled", actor: "octo", at: `t${i}`, detail: "x" })),
      comments: Array.from({ length: 5 }, () => ({ author: "octo", body: "y".repeat(5_000), at: "t" })),
    });
    const text = renderLinkedHistory(
      [
        { number: 8, linkedFrom: [5], history: long },
        { number: 9, linkedFrom: [5], error: "GitHub GET /repos/octo/app/issues/9 failed with 404" },
      ],
      [{ issue: 5, numbers: [20, 21] }],
    );
    const item8 = text.slice(text.indexOf("### Issue #8"), text.indexOf("### #9"));
    expect(item8.length).toBeLessThan(3_200);
    expect(item8).toContain("t199"); // the latest events are kept
    expect(text).toContain(
      "### #9 (linked from #5) could not be fetched: GitHub GET /repos/octo/app/issues/9 failed with 404",
    );
    expect(text).toContain("#5 links more items than are fetched; not fetched: #20, #21");
    expect(renderLinkedHistory([], [])).toBe("");
  });

  test("REQ-001-47 a busy PR's Reviews and latest comments survive the cap next to its latest events", () => {
    const busy = history(47, {
      isPullRequest: true,
      events: [
        ...Array.from({ length: 19 }, (_, i) => ({
          event: i % 2 ? "unlabeled" : "labeled",
          actor: "issueflow[bot]",
          at: `2026-11-10T00:00:${String(i).padStart(2, "0")}Z`,
          detail: "agent:reviewing",
        })),
        { event: "convert_to_draft", actor: "issueflow[bot]", at: "2026-11-10T09:00:00Z" },
      ],
      reviews: Array.from({ length: 5 }, (_, i) => ({
        state: "commented",
        author: "issueflow[bot]",
        body: `review ${i + 1} ${"r".repeat(500)}`,
        at: "2026-11-10T08:00:00Z",
      })),
      comments: Array.from({ length: 5 }, (_, i) => ({
        author: "octo",
        body: `comment ${i + 1} ${"c".repeat(500)}`,
        at: "2026-11-10T08:30:00Z",
      })),
    });
    const text = renderLinkedHistory([{ number: 47, linkedFrom: [51], history: busy }], []);
    expect(text).not.toEndWith("(truncated)"); // the item as a whole is not cut
    expect(text.slice(text.indexOf("### PR #47")).length).toBeLessThanOrEqual(3_000);
    expect(text).toContain("convert_to_draft by issueflow[bot]");
    for (let i = 1; i <= 5; i++) expect(text).toContain(`review ${i} `);
    expect(text).toContain("comment 5 ");
  });

  test("REQ-001-47 a Planner pass gets the Linked history of what the issues link to, fetched once, at most 5 per issue, never the issue itself", async () => {
    for (const n of [47, 1, 2, 3, 4, 6]) gh.histories.set(n, history(n));
    await planner.startPass(
      "octo/app",
      "/c",
      [item(51, { body: "Why did #47 stay in draft? Not #51 itself." }), item(5, { body: "#47 #1 #2 #3 #4 #6 #7" })],
      none,
    );
    const prompt = runner.started[0]?.prompt ?? "";
    expect(gh.of("itemHistory").map((c) => c[2])).toEqual([47, 1, 2, 3, 4]);
    expect(prompt).toContain("## Linked history");
    expect(prompt).toContain("### Issue #47 Linked 47 (linked from #51, #5)");
    expect(prompt).toContain("#5 links more items than are fetched; not fetched: #6, #7");
    expect(prompt).not.toContain("### Issue #51");
  });

  test("REQ-001-47 a failed fetch does not stop the pass", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5, { body: "see #9" })], none);
    expect(store.session(id)).toBeDefined();
    expect(runner.started[0]?.prompt).toContain("### #9 (linked from #5) could not be fetched");
  });

  test("REQ-001-47 an issue without links gets the prompt it got before, with no fetch", async () => {
    await planner.startPass("octo/app", "/c", [item(5)], none);
    expect(gh.of("itemHistory")).toEqual([]);
    expect(runner.started[0]?.prompt).toEndWith(`## Context\n\n${renderContext({ assess: [item(5)], ...none })}\n`);
  });

  test("REQ-001-47 a revision gets the history of what the description and the new comments link to; a resumed session only what is new", async () => {
    for (const n of [47, 48]) gh.histories.set(n, history(n));
    const linking = item(5, { body: "Since #47 …" });
    const batch = await planner.startPass("octo/app", "/c", [linking], none);
    finishTurn(batch, [entry(5)]);
    await planner.sync(batch);
    gh.calls = [];

    // a fresh session after the batch: description and comments
    const own = await planner.revise(
      "octo/app",
      "/c",
      linking,
      { comments: [comment(300, "and #48")], bodyChanged: false },
      none,
    );
    expect(gh.of("itemHistory").map((c) => c[2])).toEqual([47, 48]);
    expect(runner.started.at(-1)?.prompt).toContain("### Issue #48 Linked 48 (linked from #5)");
    expect(runner.started.at(-1)?.prompt).toContain("### Issue #47");

    // resumed: only what the new comments link to beyond the description
    store.setAgentSessionId(own, "sess-own");
    store.patchSession(own, { state: "idle" });
    gh.calls = [];
    await planner.revise(
      "octo/app",
      "/c",
      linking,
      { comments: [comment(301, "#47 and #48 again")], bodyChanged: false },
      none,
    );
    expect(gh.of("itemHistory").map((c) => c[2])).toEqual([48]);
    expect(runner.resumed.at(-1)?.[1]).toContain("### Issue #48");
    expect(runner.resumed.at(-1)?.[1]).not.toContain("### Issue #47");
    gh.calls = [];
    await planner.revise("octo/app", "/c", linking, { comments: [comment(302, "#47 only")], bodyChanged: false }, none);
    expect(gh.of("itemHistory")).toEqual([]);
    expect(runner.resumed.at(-1)?.[1]).not.toContain("## Linked history");

    // edited description: from scratch, with everything
    gh.calls = [];
    await planner.revise(
      "octo/app",
      "/c",
      item(5, { body: "Now #48" }),
      { comments: [comment(303, "see #47")], bodyChanged: true },
      none,
    );
    expect(gh.of("itemHistory").map((c) => c[2])).toEqual([48, 47]);
    expect(runner.started.at(-1)?.prompt).toContain("### Issue #47");
  });
});

describe("Mockups", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const save = (id: number, name: string, data: Uint8Array = PNG) => {
    const folder = join(runner.sessionDir(id), "mockups");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, name), data);
    return join(folder, name);
  };
  const bodyOf = (call: unknown[] | undefined) => String(call?.at(-1));

  test("REQ-001-61 Mockups are published under issue-<n>/<hash>/ and shown after the approach, linked by commit", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], none);
    const a = save(id, "option a.png");
    save(id, "b.png");
    finishTurn(id, [
      entry(5, {
        questions: ["Which one?"],
        mockups: [
          { path: a, caption: "Option A: softer tones" },
          { path: "mockups/b.png", caption: "Option B" },
        ],
      }),
    ]);
    await planner.sync(id);
    expect(worktrees.published).toHaveLength(1);
    const { folder, names, message } = worktrees.published[0] ?? { folder: "", names: [], message: "" };
    expect(folder).toMatch(/^issue-5\/[0-9a-f]{12}$/);
    expect(names).toEqual(["1-option-a.png", "2-b.png"]);
    expect(message).toBe("Mockups of #5");
    const body = bodyOf(gh.of("createComment")[0]);
    expect(body).toContain(
      `![Option A: softer tones](https://github.com/octo/app/raw/c0ffee/${folder}/1-option-a.png)`,
    );
    expect(body.indexOf("Approach for 5")).toBeLessThan(body.indexOf("### Mockups"));
    expect(body.indexOf("### Mockups")).toBeLessThan(body.indexOf("**Questions**"));
  });

  test("REQ-001-61 files outside the mockups folder or not PNG/JPEG are skipped and named, the rest published", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], none);
    save(id, "ok.png");
    save(id, "notes.txt", Buffer.from("hello"));
    writeFileSync(join(runner.sessionDir(id), "result-copy.png"), PNG);
    finishTurn(id, [
      entry(5, {
        mockups: [
          { path: "mockups/ok.png", caption: "OK" },
          { path: "mockups/notes.txt", caption: "Text" },
          { path: "result-copy.png", caption: "Outside" },
        ],
      }),
    ]);
    await planner.sync(id);
    expect(worktrees.published[0]?.names).toEqual(["1-ok.png"]);
    const body = bodyOf(gh.of("createComment")[0]);
    expect(body).toContain("`mockups/notes.txt`: not a PNG or JPEG");
    expect(body).toContain("`result-copy.png`: outside mockups/");
  });

  test("REQ-001-61 a failed publish still posts the Assessment and says the Mockups could not be published", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], none);
    save(id, "a.png");
    worktrees.fail = true;
    finishTurn(id, [entry(5, { mockups: [{ path: "mockups/a.png", caption: "A" }] })]);
    await planner.sync(id);
    const body = bodyOf(gh.of("createComment")[0]);
    expect(body).toContain("Approach for 5");
    expect(body).toContain("The Mockups could not be published: push rejected");
    expect(gh.of("addLabels")).toContainEqual(["addLabels", "octo/app", 5, ["agent:proposed"]]);
  });

  test("REQ-001-61 a revision without Mockups drops the section; an unchanged Result publishes nothing", async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], none);
    save(id, "a.png");
    const withMockups = [entry(5, { mockups: [{ path: "mockups/a.png", caption: "A" }] })];
    finishTurn(id, withMockups);
    await planner.sync(id);
    store.patchSession(id, { state: "idle", needsSync: true });
    await planner.sync(id); // same Result again
    expect(worktrees.published).toHaveLength(1);

    finishTurn(id, [entry(5, { approach: "Revised" })]);
    await planner.sync(id);
    const edited = bodyOf(gh.of("updateComment").at(-1));
    expect(edited).toContain("Revised");
    expect(edited).not.toContain("### Mockups");
  });
});
