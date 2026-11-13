import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import type { Comment, Item } from "../src/github/client.ts";
import { bodyHash, isCommand, Planner, renderAssessment, renderContext } from "../src/planner.ts";
import type { PlannerResult } from "../src/results.ts";
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

const entry = (issue: number, extra: Partial<PlannerResult[number]> = {}): PlannerResult[number] => ({
  issue,
  verdict: "proposed",
  approach: `Approach for ${issue}`,
  bundleWith: [],
  blockedBy: [],
  questions: [],
  ...extra,
});

class FakeGitHub {
  calls: unknown[][] = [];
  private nextId = 100;
  async addLabels(repo: string, issue: number, labels: string[]) {
    this.calls.push(["addLabels", repo, issue, labels]);
  }
  async removeLabel(repo: string, issue: number, label: string) {
    this.calls.push(["removeLabel", repo, issue, label]);
  }
  async createComment(repo: string, issue: number, body: string) {
    this.calls.push(["createComment", repo, issue, body]);
    return this.nextId++;
  }
  async updateComment(repo: string, id: number, body: string) {
    this.calls.push(["updateComment", repo, id, body]);
  }
  of(name: string) {
    return this.calls.filter((c) => c[0] === name);
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
    const id = this.store.createSession({ repo: o.repo, role: o.role, kind: o.kind, issues: o.issues });
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "planner-"));
  store = new Store(":memory:");
  gh = new FakeGitHub();
  runner = new FakeRunner(store, dir);
  planner = new Planner({ config, store, gh, runner });
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
});

describe("plan revision", () => {
  const assessed = async () => {
    const id = await planner.startPass("octo/app", "/c", [item(5)], { issues: [], pulls: [] });
    finishTurn(id, [entry(5)]);
    await planner.sync(id);
    gh.calls = [];
    return id;
  };

  test("REQ-001-03 after a batch, feedback goes to a fresh Planner session for that issue with its current Assessment", async () => {
    const batch = await assessed();
    store.setClaudeSessionId(batch, "sess-batch"); // resumable, but it covers several issues
    await planner.revise("octo/app", "/c", item(5), { comments: [comment(300, "Use the v2 API")], bodyChanged: false });
    expect(runner.started.at(-1)).toMatchObject({ kind: "issue", issues: [5], role: "planner" });
    expect(runner.started.at(-1)?.prompt).toContain("Approach for 5");
    expect(runner.started.at(-1)?.prompt).toContain("Use the v2 API");
    expect(store.issue("octo/app", 5).lastHandledCommentId).toBe(300);
  });

  test("REQ-001-03 later feedback resumes that issue's own Planner session, and an edited body is mentioned", async () => {
    await assessed();
    const own = await planner.revise("octo/app", "/c", item(5), { comments: [comment(300, "a")], bodyChanged: false });
    store.setClaudeSessionId(own, "sess-own");
    store.patchSession(own, { state: "idle" });
    const again = await planner.revise("octo/app", "/c", item(5, { body: "New body" }), {
      comments: [],
      bodyChanged: true,
    });
    expect(again).toBe(own);
    expect(runner.resumed).toEqual([[own, expect.stringContaining("New body")]]);
    expect(store.issue("octo/app", 5).bodyHash).toBe(bodyHash("New body"));
  });

  test("REQ-001-03 the revised Assessment edits the existing comment in place and updates the label", async () => {
    await assessed();
    const own = await planner.revise("octo/app", "/c", item(5), { comments: [comment(300, "a")], bodyChanged: false });
    finishTurn(own, [entry(5, { verdict: "wontfix-proposed", approach: "Not worth it" })]);
    await planner.sync(own);
    expect(gh.of("createComment")).toEqual([]);
    expect(gh.of("updateComment")).toEqual([
      ["updateComment", "octo/app", 100, expect.stringContaining("Not worth it")],
    ]);
    expect(gh.of("addLabels")).toEqual([["addLabels", "octo/app", 5, ["agent:wontfix-proposed"]]]);
    expect(runner.closed).not.toContain(own);
  });

  test("REQ-001-19 a turn the Owner started is synced too, and an unchanged Result touches nothing on GitHub", async () => {
    await assessed();
    const own = await planner.revise("octo/app", "/c", item(5), { comments: [comment(300, "a")], bodyChanged: false });
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
