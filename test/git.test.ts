import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clones, gitAuthArgs } from "../src/git.ts";

let dir: string;
let origin: string;

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "git-"));
  origin = join(dir, "origin");
  git(dir, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "README.md"), "v1");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "v1");
});
afterEach(() => rmSync(dir, { recursive: true }));

const clones = () =>
  new Clones({
    root: join(dir, "clones"),
    token: async () => "tok-123",
    remoteUrl: (repo) => join(dir, repo.split("/")[1] ?? ""),
  });

describe("main clones", () => {
  test("clones a repository once and resets it to the default branch on every refresh", async () => {
    const c = clones();
    const path = await c.mainClone("octo/origin");
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("v1");

    writeFileSync(join(origin, "README.md"), "v2");
    git(origin, "commit", "-qam", "v2");
    writeFileSync(join(path, "README.md"), "local junk");
    writeFileSync(join(path, "stray.txt"), "x");
    expect(await c.mainClone("octo/origin")).toBe(path);
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("v2");
    expect(() => readFileSync(join(path, "stray.txt"))).toThrow();
  });

  test("REQ-001-15 never stores the token in the clone", async () => {
    const path = await clones().mainClone("octo/origin");
    expect(readFileSync(join(path, ".git", "config"), "utf8")).not.toContain("tok-123");
  });

  test("REQ-001-15 passes the token as a one-off HTTP header", () => {
    expect(gitAuthArgs("tok")).toEqual([
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`,
    ]);
  });
});
