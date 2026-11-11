/**
 * Local clones of the managed repositories. The App token is passed to git per command as an
 * HTTP header and never written into a clone, so agents working there cannot read it (REQ-001-15).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const gitAuthArgs = (token: string): string[] => [
  "-c",
  `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
];

export function git(cwd: string, args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0)
    throw new Error(
      `git ${args.filter((a) => !a.includes("extraheader")).join(" ")} failed: ${p.stderr.toString().trim()}`,
    );
  return p.stdout.toString().trim();
}

export class Clones {
  constructor(
    private readonly o: {
      /** Clones live in `<root>/<owner>/<name>`. */
      root: string;
      /** Installation token for the repository. */
      token: (repo: string) => Promise<string>;
      remoteUrl?: (repo: string) => string;
    },
  ) {}

  /** The main clone, freshly reset to the remote's default branch. */
  async mainClone(repo: string): Promise<string> {
    const path = join(this.o.root, ...repo.split("/"));
    const auth = gitAuthArgs(await this.o.token(repo));
    const url = this.o.remoteUrl?.(repo) ?? `https://github.com/${repo}.git`;
    if (!existsSync(join(path, ".git"))) {
      mkdirSync(path, { recursive: true });
      git(path, [...auth, "clone", "-q", url, "."]);
    } else {
      git(path, [...auth, "fetch", "-q", "--prune", "origin"]);
      git(path, [...auth, "remote", "set-head", "origin", "--auto"]);
    }
    git(path, ["checkout", "-q", "-f", "--detach", "origin/HEAD"]);
    git(path, ["clean", "-qfdx"]);
    return path;
  }
}
