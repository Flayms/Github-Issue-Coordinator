import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const make = (setup?: string, maxWorktrees: number | (() => number) = 5) => {
  const opts = { token: async () => "tok-123", remoteUrl: () => origin };
  return new Worktrees({
    root: join(dir, "state"),
    clones: new Clones({ root: join(dir, "state", "clones"), ...opts }),
    ...opts,
    setup: () => setup,
    maxWorktrees: typeof maxWorktrees === "number" ? () => maxWorktrees : maxWorktrees,
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

  test("REQ-005-02 the checkout holds no token and its git data stays inside it", async () => {
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

  test("REQ-001-28 fetches the default branch into a Worktree for a merge-conflict round", async () => {
    const w = make();
    const wt = await w.create("octo/app", [5], "x");
    writeFileSync(join(origin, "README.md"), "v2");
    git(origin, "commit", "-qam", "v2");
    await w.fetchBase("octo/app", wt.path);
    expect(git(wt.path, "rev-parse", "origin/main")).toBe(git(origin, "rev-parse", "main"));
    expect(readFileSync(join(wt.path, ".git", "config"), "utf8")).not.toContain("tok-123");
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

  test("REQ-001-58 a replacing push overwrites a leftover remote branch that a plain push may not", async () => {
    git(origin, "checkout", "-q", "-b", "agent/5-x");
    writeFileSync(join(origin, "old.txt"), "closed PR");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "closed PR");
    git(origin, "checkout", "-q", "main");

    const w = make();
    const wt = await w.create("octo/app", [5], "x");
    writeFileSync(join(wt.path, "f.txt"), "1");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "work");
    await expect(w.push("octo/app", wt.path, wt.branch)).rejects.toThrow();
    await w.push("octo/app", wt.path, wt.branch, { replace: true });
    expect(git(origin, "rev-parse", wt.branch)).toBe(w.head(wt.path));
  });

  test("knows the checkout's branch and the default branch", async () => {
    const w = make();
    const wt = await w.create("octo/app", [5], "x");
    expect(w.currentBranch(wt.path)).toBe("agent/5-x");
    expect(w.defaultBranch(wt.path)).toBe("main");
  });

  test("respects maxWorktrees", async () => {
    const w = make(undefined, 1);
    await w.create("octo/app", [5], "x");
    expect(w.hasRoom()).toBe(false);
    expect(w.create("octo/app", [6], "y")).rejects.toThrow("maxWorktrees");
  });

  test("REQ-003-36 maxWorktrees is read on every check, so a saved setting applies without a restart", async () => {
    let max = 1;
    const w = make(undefined, () => max);
    await w.create("octo/app", [5], "x");
    expect(w.hasRoom()).toBe(false);
    max = 2;
    expect(w.hasRoom()).toBe(true);
    await w.create("octo/app", [6], "y");
    expect(w.hasRoom()).toBe(false);
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
    expect(make().reviewPath("octo/app", 9)).toBe(path);
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

  test("REQ-001-43 re-attaching builds a Worktree from the PR's remote branch, which still pushes as a fast-forward", async () => {
    git(origin, "checkout", "-q", "-b", "agent/5-fix-it");
    writeFileSync(join(origin, "fix.txt"), "fix");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "fix");
    const remoteHead = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "-q", "main");

    const w = make("echo ready > setup-ran");
    const wt = await w.attach("octo/app", [5, 6], "agent/5-fix-it");
    expect(wt).toEqual({ path: join(dir, "state", "worktrees", "octo", "app", "5"), branch: "agent/5-fix-it" });
    expect(w.head(wt.path)).toBe(remoteHead);
    expect(w.currentBranch(wt.path)).toBe("agent/5-fix-it");
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/agent/5-fix-it");
    expect(readFileSync(join(wt.path, "setup-ran"), "utf8").trim()).toBe("ready");
    expect(w.commitsAhead(wt.path)).toBe(1);
    expect(readFileSync(join(wt.path, ".git", "config"), "utf8")).not.toContain("tok-123");

    writeFileSync(join(wt.path, "more.txt"), "more");
    git(wt.path, "add", "more.txt");
    git(wt.path, "commit", "-qm", "more");
    await w.push("octo/app", wt.path, wt.branch);
    expect(git(origin, "rev-parse", "agent/5-fix-it")).toBe(w.head(wt.path));
    expect(git(origin, "rev-parse", "agent/5-fix-it~1")).toBe(remoteHead);
  });

  test("REQ-001-43 re-attaching never reuses a folder that exists, and respects maxWorktrees", async () => {
    git(origin, "branch", "agent/5-fix-it");
    const w = make(undefined, 1);
    await w.create("octo/app", [5], "fix it");
    expect(w.attach("octo/app", [5], "agent/5-fix-it")).rejects.toThrow("already exists");
    expect(w.attach("octo/app", [6], "agent/5-fix-it")).rejects.toThrow("maxWorktrees");
  });

  test("REQ-001-48 every Worktree's git ignores .coordinator/ locally, also a re-used or re-attached one", async () => {
    const w = make();
    const wt = await w.create("octo/app", [5], "x");
    mkdirSync(join(wt.path, ".coordinator", "screenshots"), { recursive: true });
    writeFileSync(join(wt.path, ".coordinator", "screenshots", "a.png"), "png");
    expect(git(wt.path, "status", "--porcelain")).toBe("");
    expect(git(wt.path, "ls-files")).toBe("README.md"); // not via a tracked .gitignore
    await w.create("octo/app", [5], "x");
    const lines = readFileSync(join(wt.path, ".git", "info", "exclude"), "utf8").split("\n");
    expect(lines.filter((l) => l === ".coordinator/")).toHaveLength(1);

    git(origin, "branch", "agent/9-y");
    const attached = await w.attach("octo/app", [9], "agent/9-y");
    mkdirSync(join(attached.path, ".coordinator"), { recursive: true });
    writeFileSync(join(attached.path, ".coordinator", "b.png"), "png");
    expect(git(attached.path, "status", "--porcelain")).toBe("");
  });

  test("REQ-001-49 publishes Screenshots on the orphan branch agent-screenshots under pr-<n>/<head>/, one commit per publish", async () => {
    const w = make();
    const wt = await w.create("octo/app", [5], "x");
    writeFileSync(join(wt.path, "f.txt"), "1");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-qm", "work");
    await w.push("octo/app", wt.path, wt.branch);
    const head = w.head(wt.path);
    const mainBefore = git(origin, "rev-parse", "main");

    const first = await w.publishScreenshots("octo/app", 77, head, [{ name: "1-board.png", data: Buffer.from("A") }]);
    expect(git(origin, "rev-parse", "agent-screenshots")).toBe(first);
    expect(git(origin, "show", `${first}:pr-77/${head}/1-board.png`)).toBe("A");
    expect(git(origin, "rev-list", "--parents", "-n", "1", first)).toBe(first); // no parent: an orphan
    expect(Bun.spawnSync(["git", "merge-base", first, "main"], { cwd: origin }).exitCode).not.toBe(0);

    const second = await w.publishScreenshots("octo/app", 77, "h2", [
      { name: "1-board.png", data: Buffer.from("B") },
      { name: "2-list.jpg", data: Buffer.from("C") },
    ]);
    expect(git(origin, "rev-parse", "agent-screenshots")).toBe(second);
    expect(git(origin, "rev-parse", `${second}^`)).toBe(first);
    expect(git(origin, "show", `${second}:pr-77/h2/2-list.jpg`)).toBe("C");
    expect(git(origin, "show", `${second}:pr-77/${head}/1-board.png`)).toBe("A"); // earlier files stay
    expect(git(origin, "show", `${first}:pr-77/${head}/1-board.png`)).toBe("A");

    // Neither the default branch nor the PR branch nor the Worktree changes.
    expect(git(origin, "rev-parse", "main")).toBe(mainBefore);
    expect(git(origin, "rev-parse", wt.branch)).toBe(head);
    expect(w.head(wt.path)).toBe(head);
    expect(git(wt.path, "status", "--porcelain")).toBe("");
  });

  test("REQ-001-61 publishes Mockups under issue-<n>/<hash>/ on the same branch, keeping the Screenshots", async () => {
    const w = make();
    const shots = await w.publishScreenshots("octo/app", 77, "h1", [{ name: "1-board.png", data: Buffer.from("A") }]);
    const mockups = await w.publishImages(
      "octo/app",
      "issue-5/abc123",
      [{ name: "1-option-a.png", data: Buffer.from("M") }],
      "Mockups of #5",
    );
    expect(git(origin, "rev-parse", "agent-screenshots")).toBe(mockups);
    expect(git(origin, "rev-parse", `${mockups}^`)).toBe(shots);
    expect(git(origin, "show", `${mockups}:issue-5/abc123/1-option-a.png`)).toBe("M");
    expect(git(origin, "show", `${mockups}:pr-77/h1/1-board.png`)).toBe("A");
    expect(git(origin, "log", "-1", "--format=%s", mockups)).toBe("Mockups of #5");
  });
});
