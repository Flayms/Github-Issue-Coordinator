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
  of(name: string) {
    return this.calls.filter((c) => c[0] === name);
  }
}

class FakeWorktrees {
  created: [string, number[], string][] = [];
  pushed: string[] = [];
  removed: string[] = [];
  ahead = 0;
  room = true;
  hasRoom() {
    return this.room;
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
  test("REQ-001-06 / REQ-001-09 labels the Bundle in progress and starts a fresh session in one new Worktree", async () => {
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
        cwd: "/wt/5",
        model: { model: "sonnet" },
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

  test("REQ-001-09 when the turn ends, pushes the branch and opens a PR with the agent note that closes every issue", async () => {
    const id = await impl.start("octo/app", [item(5), item(6)]);
    gh.calls = [];
    wt.ahead = 2;
    finish(id);
    await impl.sync(id);
    expect(wt.pushed).toEqual(["agent/5-x"]);
    const [, pr] = gh.of("createPull")[0] as [string, { title: string; body: string; head: string; base: string }];
    expect(pr.title).toBe("Dark mode");
    expect(pr.head).toBe("agent/5-x");
    expect(pr.base).toBe("main");
    expect(pr.body).toStartWith("> [!Note]\n> 🤖 Claude (sonnet) writing on behalf of octo");
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

  test("REQ-001-14 cleanup removes the Worktree, closes the sessions and clears the agent labels", async () => {
    const id = await impl.start("octo/app", [item(5), item(6)]);
    store.patchSession(id, { state: "idle" });
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
  });

  test("REQ-001-19 cleanup waits while the Owner is chatting with the session", async () => {
    await impl.start("octo/app", [item(5)]);
    expect(await impl.cleanup("octo/app", [5], "/wt/5")).toBe(false);
    expect(wt.removed).toEqual([]);
  });
});
