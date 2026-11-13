/**
 * Worktrees: one checkout per issue or Bundle (REQ-001-06, REQ-001-09) and temporary review
 * checkouts (REQ-001-10). Each is a local clone of the main clone, not a `git worktree`: a real
 * worktree writes commits into the main clone's `.git`, outside the Implementer's sandbox. Origin
 * points at GitHub without credentials; the Coordinator fetches and pushes with the token (REQ-001-15).
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
      maxWorktrees: number;
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
    return this.count() < this.o.maxWorktrees;
  }

  /** The Worktree of an issue or Bundle (named after its first issue); reused if it exists. */
  async create(repo: string, issues: number[], title: string): Promise<Worktree> {
    const first = issues[0] ?? 0;
    const branch = branchName(first, title);
    const path = join(this.o.root, "worktrees", ...repo.split("/"), String(first));
    if (existsSync(join(path, ".git"))) return { path, branch: git(path, ["rev-parse", "--abbrev-ref", "HEAD"]) };
    if (!this.hasRoom()) throw new Error(`maxWorktrees (${this.o.maxWorktrees}) reached`);

    await this.checkout(repo, path);
    git(path, ["checkout", "-q", "-b", branch, "origin/HEAD"]);
    git(path, ["config", "user.name", this.o.commitAuthor.name]);
    git(path, ["config", "user.email", this.o.commitAuthor.email]);
    const setup = this.o.setup(repo);
    if (setup) {
      const p = Bun.spawnSync(["sh", "-c", setup], { cwd: path, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) {
        rmSync(path, { recursive: true, force: true });
        throw new Error(`setup command "${setup}" failed: ${p.stderr.toString().trim().slice(-2000)}`);
      }
    }
    return { path, branch };
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

  async push(repo: string, path: string, branch: string): Promise<void> {
    git(path, [...gitAuthArgs(await this.o.token(repo)), "push", "-q", "origin", `${branch}:refs/heads/${branch}`]);
  }

  /**
   * Fetches the default branch into a Worktree, so the Implementer can merge it to resolve merge
   * conflicts; its sandbox has no credentials to fetch itself (REQ-001-28, REQ-001-15).
   */
  async fetchBase(repo: string, path: string): Promise<void> {
    const base = this.defaultBranch(path);
    git(path, [...gitAuthArgs(await this.o.token(repo)), "fetch", "-q", "origin", base]);
  }

  /**
   * Fetches the Worktree's branch from GitHub into `origin/<branch>` and returns its head, or null
   * if GitHub has no such branch yet. Someone else (e.g. the Owner) may have pushed to it (REQ-001-31).
   */
  async fetchBranch(repo: string, path: string, branch: string): Promise<string | null> {
    const auth = gitAuthArgs(await this.o.token(repo));
    if (!git(path, [...auth, "ls-remote", "--heads", "origin", `refs/heads/${branch}`])) return null;
    git(path, [...auth, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    return git(path, ["rev-parse", `refs/remotes/origin/${branch}`]);
  }

  /** Whether the Worktree's HEAD contains a commit, i.e. pushing it would be a fast-forward from there. */
  hasCommit(path: string, sha: string): boolean {
    return Bun.spawnSync(["git", "merge-base", "--is-ancestor", sha, "HEAD"], { cwd: path }).exitCode === 0;
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
