import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clones } from "../src/git.ts";
import { branchName, Worktrees } from "../src/worktrees.ts";

let dir: string;
let origin: string;

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wt-"));
  origin = join(dir, "app");
  git(dir, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "README.md"), "v1");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "v1");
  git(origin, "config", "receive.denyCurrentBranch", "ignore");
});
afterEach(() => rmSync(dir, { recursive: true }));

const make = (setup?: string, maxWorktrees = 5) => {
  const opts = { token: async () => "tok-123", remoteUrl: () => origin };
  return new Worktrees({
    root: join(dir, "state"),
    clones: new Clones({ root: join(dir, "state", "clones"), ...opts }),
    ...opts,
    setup: () => setup,
    maxWorktrees,
    commitAuthor: { name: "Claude", email: "noreply@anthropic.com" },
  });
};

describe("worktrees", () => {
  test("REQ-001-09 branch names are agent/<issue>-<slug>", () => {
    expect(branchName(12, "Fix: the Login page (again)!")).toBe("agent/12-fix-the-login-page-again");
    expect(branchName(3, "x".repeat(80))).toBe(`agent/3-${"x".repeat(40)}`);
  });

  test("REQ-001-09 creates a checkout of the default branch on a new branch and runs the setup command", async () => {
    const wt = await make("echo ready > setup-ran").create("octo/app", [5, 6], "Add dark mode");
    expect(wt.branch).toBe("agent/5-add-dark-mode");
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/5-add-dark-mode");
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("v1");
    expect(readFileSync(join(wt.path, "setup-ran"), "utf8").trim()).toBe("ready");
    const config = (key: string) => Bun.spawnSync(["git", "config", key], { cwd: wt.path }).stdout.toString().trim();
    expect(config("user.name")).toBe("Claude");
    expect(config("user.email")).toBe("noreply@anthropic.com");
  });

  test("REQ-001-15 the checkout holds no token and its git data stays inside it", async () => {
    const wt = await make().create("octo/app", [5], "x");
    expect(readFileSync(join(wt.path, ".git", "config"), "utf8")).not.toContain("tok-123");
    expect(existsSync(join(wt.path, ".git", "objects"))).toBe(true);
  });

  test("creating again for the same issue reuses the checkout", async () => {
    const w = make();
    const a = await w.create("octo/app", [5], "x");
    writeFileSync(join(a.path, "work.txt"), "in progress");
    const b = await w.create("octo/app", [5], "x");
    expect(b).toEqual(a);
    expect(readFileSync(join(b.path, "work.txt"), "utf8")).toBe("in progress");
  });

  test("a failing setup command is an error", async () => {
    expect(make("exit 3").create("octo/app", [5], "x")).rejects.toThrow("setup");
  });

  test("REQ-001-09 pushes the branch and reports the head and how many commits it adds", async () => {
    const w = make();
    const wt = await w.create("octo/app", [5], "x");
    expect(w.commitsAhead(wt.path)).toBe(0);
    writeFileSync(join(wt.path, "f.txt"), "1");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "work");
    expect(w.commitsAhead(wt.path)).toBe(1);
    await w.push("octo/app", wt.path, wt.branch);
    expect(git(origin, "rev-parse", wt.branch)).toBe(w.head(wt.path));
  });

  test("respects maxWorktrees", async () => {
    const w = make(undefined, 1);
    await w.create("octo/app", [5], "x");
    expect(w.hasRoom()).toBe(false);
    expect(w.create("octo/app", [6], "y")).rejects.toThrow("maxWorktrees");
  });

  test("REQ-001-10 review checkouts are detached at the PR head", async () => {
    git(origin, "checkout", "-qb", "feature");
    writeFileSync(join(origin, "f.txt"), "pr");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "pr");
    const sha = git(origin, "rev-parse", "HEAD");
    git(origin, "update-ref", "refs/pull/9/head", sha);
    git(origin, "checkout", "-q", "main");
    const path = await make().reviewCheckout("octo/app", 9, sha);
    expect(git(path, "rev-parse", "HEAD")).toBe(sha);
    expect(readFileSync(join(path, "f.txt"), "utf8")).toBe("pr");
    make().remove(path);
    expect(existsSync(path)).toBe(false);
  });

  test("REQ-001-14 removing a Worktree deletes the checkout and its local branch", async () => {
    const w = make(undefined, 1);
    const wt = await w.create("octo/app", [5], "x");
    w.remove(wt.path);
    expect(existsSync(wt.path)).toBe(false);
    expect(w.hasRoom()).toBe(true);
  });
});
