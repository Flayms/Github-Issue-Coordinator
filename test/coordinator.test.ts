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
  resume(id: number, prompt: string) {
    this.resumed.push([id, prompt]);
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
let coordinator: Coordinator;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coord-"));
  now = new Date("2026-11-11T10:00:00Z");
  store = new Store(":memory:", () => now);
  gh = new FakeGitHub();
  runner = new FakeRunner(store, dir);
  coordinator = new Coordinator({
    config,
    store,
    gh,
    runner,
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
      clones: { mainClone: async () => "/c" },
      now: () => now,
      log: (m) => logs.push(m),
    });
    await broken.tick();
    expect(logs.join("\n")).toContain("GitHub down");
  });
});
