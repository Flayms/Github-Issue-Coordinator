/**
 * Worktrees: one checkout per issue or Bundle (REQ-001-06, REQ-001-09) and temporary review
 * checkouts (REQ-001-10). Each is a local clone of the main clone, not a `git worktree`, so each one
 * has its own `.git` and can be removed on its own. Origin points at GitHub without credentials; the
 * Coordinator fetches and pushes with the token (REQ-005-02).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Clones, git, gitAuthArgs } from "./git.ts";

export const branchName = (issue: number, title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `agent/${issue}-${slug || "work"}`;
};

/** The orphan branch Screenshots are published on (REQ-001-49). */
export const SCREENSHOT_BRANCH = "agent-screenshots";

/** REQ-001-48: the Worktree's git ignores `.coordinator/` (Screenshots) through `.git/info/exclude`, not a tracked file. */
function excludeCoordinatorFolder(path: string): void {
  const file = join(path, ".git", "info", "exclude");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").includes(".coordinator/")) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}.coordinator/\n`);
}

export interface Worktree {
  path: string;
  branch: string;
}

export class Worktrees {
  constructor(
    private readonly o: {
      /** Worktrees live in `<root>/worktrees/<owner>/<name>/<issue>`, review checkouts in `<root>/reviews/…`. */
      root: string;
      clones: Pick<Clones, "mainClone">;
      token: (repo: string) => Promise<string>;
      remoteUrl?: (repo: string) => string;
      /** The repository's setup command (config `repos[].setup`). */
      setup: (repo: string) => string | undefined;
      /** Read on every check, so a saved setting applies without a restart (REQ-007-05). */
      maxWorktrees: () => number;
      /** Identity for the agent's commits (the server has no global git identity). */
      commitAuthor: { name: string; email: string };
    },
  ) {}

  private url(repo: string): string {
    return this.o.remoteUrl?.(repo) ?? `https://github.com/${repo}.git`;
  }

  /** Number of Worktrees on disk across all repositories. */
  count(): number {
    const base = join(this.o.root, "worktrees");
    if (!existsSync(base)) return 0;
    return readdirSync(base).flatMap((owner) =>
      readdirSync(join(base, owner)).flatMap((name) => readdirSync(join(base, owner, name))),
    ).length;
  }

  hasRoom(): boolean {
    return this.count() < this.o.maxWorktrees();
  }

  /** The Worktree of an issue or Bundle (named after its first issue); reused if it exists. */
  async create(repo: string, issues: number[], title: string): Promise<Worktree> {
    const branch = branchName(issues[0] ?? 0, title);
    const path = this.path(repo, issues);
    if (existsSync(join(path, ".git"))) {
      excludeCoordinatorFolder(path);
      return { path, branch: git(path, ["rev-parse", "--abbrev-ref", "HEAD"]) };
    }
    if (!this.hasRoom()) throw new Error(`maxWorktrees (${this.o.maxWorktrees()}) reached`);

    await this.checkout(repo, path);
    git(path, ["checkout", "-q", "-b", branch, "origin/HEAD"]);
    this.prepare(repo, path);
    return { path, branch };
  }

  /**
   * REQ-001-43: the Worktree of an orphaned agent PR, rebuilt from its remote branch and tracking it,
   * so later pushes stay fast-forwards. Never reuses a folder that exists.
   */
  async attach(repo: string, issues: number[], branch: string): Promise<Worktree> {
    const path = this.path(repo, issues);
    if (existsSync(path)) throw new Error(`a folder already exists at ${path}`);
    if (!this.hasRoom()) throw new Error(`maxWorktrees (${this.o.maxWorktrees()}) reached`);
    await this.checkout(repo, path);
    git(path, ["checkout", "-q", "-b", branch, "--track", `origin/${branch}`]);
    this.prepare(repo, path);
    return { path, branch };
  }

  /** Where the Worktree of an issue or Bundle lives, named after its first issue. */
  path(repo: string, issues: number[]): string {
    return join(this.o.root, "worktrees", ...repo.split("/"), String(issues[0] ?? 0));
  }

  /** Commit identity and the repository's setup command; a failed setup removes the checkout. */
  private prepare(repo: string, path: string): void {
    git(path, ["config", "user.name", this.o.commitAuthor.name]);
    git(path, ["config", "user.email", this.o.commitAuthor.email]);
    excludeCoordinatorFolder(path);
    const setup = this.o.setup(repo);
    if (setup) {
      const p = Bun.spawnSync(["sh", "-c", setup], { cwd: path, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) {
        rmSync(path, { recursive: true, force: true });
        throw new Error(`setup command "${setup}" failed: ${p.stderr.toString().trim().slice(-2000)}`);
      }
    }
  }

  reviewPath(repo: string, pr: number): string {
    return join(this.o.root, "reviews", ...repo.split("/"), String(pr));
  }

  /** A detached checkout of a PR's head commit, for a Review (REQ-001-10). */
  async reviewCheckout(repo: string, pr: number, sha: string): Promise<string> {
    const path = this.reviewPath(repo, pr);
    rmSync(path, { recursive: true, force: true });
    await this.checkout(repo, path);
    git(path, [...gitAuthArgs(await this.o.token(repo)), "fetch", "-q", "origin", `pull/${pr}/head`]);
    git(path, ["checkout", "-q", "--detach", sha]);
    return path;
  }

  /** Deletes a Worktree or review checkout, including its local branch (REQ-001-14). */
  remove(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }

  /**
   * Pushes the branch as a fast-forward; `replace` overwrites the remote branch instead, for a
   * leftover branch of a closed PR (REQ-001-58).
   */
  async push(repo: string, path: string, branch: string, o: { replace?: boolean } = {}): Promise<void> {
    const ref = `${o.replace ? "+" : ""}${branch}:refs/heads/${branch}`;
    git(path, [...gitAuthArgs(await this.o.token(repo)), "push", "-q", "origin", ref]);
  }

  /**
   * REQ-001-49: commits Screenshots to the orphan branch `agent-screenshots` under `pr-<n>/<head>/`
   * (keeping the files of earlier publishes) and pushes it; returns the new commit. Works in a bare
   * repository of its own, so neither a Worktree nor any other branch is touched.
   */
  async publishScreenshots(
    repo: string,
    pr: number,
    head: string,
    files: { name: string; data: Uint8Array }[],
  ): Promise<string> {
    return this.publishImages(repo, `pr-${pr}/${head}`, files, `Screenshots of PR #${pr} at ${head}`);
  }

  /**
   * REQ-001-49 / REQ-001-61: commits `files` under `folder` of the `agent-screenshots` branch, on top of its
   * previous tip, and pushes it. Returns the commit, which links the images.
   */
  async publishImages(
    repo: string,
    folder: string,
    files: { name: string; data: Uint8Array }[],
    message: string,
  ): Promise<string> {
    const dir = join(this.o.root, "screenshots", ...repo.split("/"));
    if (!existsSync(join(dir, "HEAD"))) {
      mkdirSync(dir, { recursive: true });
      git(dir, ["init", "-q", "--bare"]);
    }
    const auth = gitAuthArgs(await this.o.token(repo));
    const url = this.url(repo);
    const ref = `refs/heads/${SCREENSHOT_BRANCH}`;
    const exists = git(dir, [...auth, "ls-remote", "--heads", url, SCREENSHOT_BRANCH]) !== "";
    if (exists) git(dir, [...auth, "fetch", "-q", url, `+${ref}:${ref}`]);
    const parent = exists ? git(dir, ["rev-parse", ref]) : null;

    const env = { GIT_INDEX_FILE: join(dir, "publish.index") };
    rmSync(env.GIT_INDEX_FILE, { force: true });
    git(dir, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
    for (const f of files) {
      const blob = git(dir, ["hash-object", "-w", "--stdin"], { stdin: f.data });
      git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${folder}/${f.name}`], { env });
    }
    const tree = git(dir, ["write-tree"], { env });
    const { name, email } = this.o.commitAuthor;
    const commit = git(dir, [
      "-c",
      `user.name=${name}`,
      "-c",
      `user.email=${email}`,
      "commit-tree",
      tree,
      ...(parent ? ["-p", parent] : []),
      "-m",
      message,
    ]);
    git(dir, [...auth, "push", "-q", url, `${commit}:${ref}`]);
    git(dir, ["update-ref", ref, commit]);
    return commit;
  }

  /**
   * Fetches the default branch into a Worktree, so the Implementer can merge it to resolve merge
   * conflicts (REQ-001-28).
   */
  async fetchBase(repo: string, path: string): Promise<void> {
    const base = this.defaultBranch(path);
    git(path, [...gitAuthArgs(await this.o.token(repo)), "fetch", "-q", "origin", base]);
  }

  currentBranch(path: string): string {
    return git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  /** The remote's default branch, e.g. `main`. */
  defaultBranch(path: string): string {
    return git(path, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).replace(/^origin\//, "");
  }

  head(path: string): string {
    return git(path, ["rev-parse", "HEAD"]);
  }

  /** Files the head changes against the default branch, e.g. for the workflow guard (REQ-001-65). */
  changedFiles(path: string): string[] {
    return git(path, ["diff", "--name-only", "origin/HEAD...HEAD"]).split("\n").filter(Boolean);
  }

  /** Commits on the branch that the default branch does not have. */
  commitsAhead(path: string): number {
    return Number(git(path, ["rev-list", "--count", "origin/HEAD..HEAD"]));
  }

  /** A local clone of the fresh main clone (objects hardlinked), with origin pointing at GitHub. */
  private async checkout(repo: string, path: string): Promise<void> {
    const main = await this.o.clones.mainClone(repo);
    mkdirSync(dirname(path), { recursive: true });
    git(dirname(path), ["clone", "-q", "--no-checkout", main, path]);
    git(path, ["remote", "set-url", "origin", this.url(repo)]);
    const auth = gitAuthArgs(await this.o.token(repo));
    git(path, [...auth, "fetch", "-q", "origin"]);
    git(path, [...auth, "remote", "set-head", "origin", "--auto"]);
  }
}
