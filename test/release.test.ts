import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const json = (f: string) => JSON.parse(read(f));
type Workflow = { on: unknown; permissions?: unknown; jobs: Record<string, Job> };
type Job = {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: { uses?: string; run?: string; with?: Record<string, unknown> }[];
};
/** A GitHub Actions expression, `${{ … }}`. */
const expr = (inner: string) => ["$", "{{ ", inner, " }}"].join("");
const workflow = (f: string) => Bun.YAML.parse(read(f)) as Workflow;
/** Every action is pinned to a full commit SHA, its tag in a comment. */
const pinned = (w: Workflow) =>
  Object.values(w.jobs)
    .flatMap((j) => j.steps)
    .flatMap((s) => (s.uses ? [s.uses] : []))
    .every((u) => /@[0-9a-f]{40}$/.test(u));

describe("releases", () => {
  test("REQ-007-13 release-please (node) keeps the version in package.json and the manifest; below 1.0 a breaking change bumps the minor", () => {
    const config = json("release-please-config.json");
    expect(config.packages["."]).toMatchObject({
      "release-type": "node",
      "package-name": "@flayms/issueflow",
      "bump-minor-pre-major": true,
      "include-component-in-tag": false,
      "changelog-path": "CHANGELOG.md",
    });
    expect(json(".release-please-manifest.json")).toEqual({ ".": json("package.json").version });
  });

  test("REQ-007-13 the first release is 0.1.0, not release-please's default 1.0.0", () => {
    expect(json("release-please-config.json").packages["."]["initial-version"]).toBe("0.1.0");
  });

  test("REQ-007-13 lint leaves release-please's CHANGELOG.md as it writes it, so the release PR's checks can pass", () => {
    expect(json("biome.json").files.includes).toContain("!CHANGELOG.md");
    // release-please's style: `*` bullets, which Biome would rewrite to `-`.
    const dir = mkdtempSync(join(tmpdir(), "changelog-"));
    try {
      cpSync(join(ROOT, "biome.json"), join(dir, "biome.json"));
      const changelog = "# Changelog\n\n## 0.1.0 (2026-11-21)\n\n\n### Features\n\n* a feature ([#1](https://x/1))\n";
      writeFileSync(join(dir, "CHANGELOG.md"), changelog);
      const biome = join(ROOT, "node_modules", ".bin", "biome");
      const r = Bun.spawnSync(
        [process.execPath, biome, "check", "--vcs-enabled=false", "--no-errors-on-unmatched", "CHANGELOG.md"],
        {
          cwd: dir,
        },
      );
      expect(r.stderr.toString() + r.stdout.toString()).not.toContain("format");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("REQ-007-13 release.yml runs release-please on main with an App token, then publishes a created release to npm through OIDC", () => {
    const w = workflow(".github/workflows/release.yml");
    expect(w.on).toEqual({ push: { branches: ["main"] } });
    expect(pinned(w)).toBe(true);
    const rp = w.jobs["release-please"] as Job;
    const uses = rp.steps.map((s) => s.uses?.split("@")[0]);
    expect(uses).toEqual(["actions/create-github-app-token", "googleapis/release-please-action"]);
    // Not GITHUB_TOKEN, whose PRs trigger no workflow, so the release PR's checks would never run.
    expect(rp.steps[1]?.with?.token).toBe(expr("steps.app-token.outputs.token"));
    const publish = w.jobs.publish as Job;
    expect(publish.needs).toBe("release-please");
    expect(publish.if).toBe(expr("needs.release-please.outputs.release_created == 'true'"));
    expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(publish.steps[0]?.with?.ref).toBe(expr("needs.release-please.outputs.tag_name"));
    const runs = publish.steps.flatMap((s) => (s.run ? [s.run] : []));
    expect(runs).toEqual([
      "bun install --frozen-lockfile",
      "bun run lint",
      "bun test",
      "npm publish --provenance --access public",
    ]);
    // Trusted publishing: no npm token anywhere.
    expect(read(".github/workflows/release.yml")).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  test("REQ-007-14 every PR title is checked to be a Conventional Commit; the prompts say so", () => {
    const w = workflow(".github/workflows/pr-title.yml");
    expect(w.on).toEqual({ pull_request: { types: ["opened", "reopened", "edited", "synchronize"] } });
    expect(pinned(w)).toBe(true);
    expect(Object.values(w.jobs)[0]?.steps[0]?.uses).toStartWith("amannn/action-semantic-pull-request@");
    expect(read("prompts/implementer.md")).toContain("`prTitle` is a Conventional Commit");
    expect(read("prompts/implementer.md")).toContain("Mark a breaking change with `!`");
    expect(read("prompts/reviewer.md")).toContain("the package's version or a release manifest");
  });
});

describe("package", () => {
  test("REQ-007-16 the npm package is @flayms/issueflow; the command stays issueflow", () => {
    const pkg = json("package.json");
    expect(pkg.name).toBe("@flayms/issueflow");
    expect(pkg.bin).toEqual({ issueflow: "src/cli.ts" });
    for (const f of ["README.md", "docs/setup.md"]) {
      expect(read(f)).toContain("bun add -g @flayms/issueflow");
      expect(read(f)).not.toMatch(/bun add -g issueflow/);
    }
  });

  test("REQ-007-01 / REQ-007-15 the package has the issueflow command and ships what it runs, without tests or docs", async () => {
    const pkg = json("package.json");
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ issueflow: "src/cli.ts" });
    expect(read("src/cli.ts")).toStartWith("#!/usr/bin/env bun\n");
    // `bun pm pack` reads `files` as npm does; its dry run lists each file as `packed <size> <path>`.
    const packed = Bun.spawnSync(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
    const files = [...packed.stdout.toString().matchAll(/^packed \S+ (.+)$/gm)].map((m) => m[1] as string);
    for (const f of [
      "package.json",
      "README.md",
      "config.schema.json",
      "src/cli.ts",
      "src/index.ts",
      "src/hook.ts",
      "src/dashboard/styles.css",
      "prompts/planner.md",
      "prompts/implementer.md",
      "prompts/reviewer.md",
    ])
      expect(files).toContain(f);
    expect(files.some((f) => f.startsWith("src/dashboard/assets/"))).toBe(true);
    expect(files.filter((f) => /^(test|docs|scripts)\//.test(f) || f.startsWith("."))).toEqual([]);
  });
});
