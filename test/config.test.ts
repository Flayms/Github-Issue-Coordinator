import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, parseConfig, roleSettings } from "../src/config.ts";

const valid = () => ({
  owner: { login: "octo", id: 42 },
  github: { appId: 7, privateKeyPath: "/etc/coordinator/app.pem" },
  repos: [{ name: "octo/app" }],
  roles: {
    planner: { model: "opus", effort: "high" },
    implementer: { model: "sonnet" },
    reviewer: { model: "opus" },
  },
});

const issuesOf = (raw: unknown): string[] => {
  try {
    parseConfig(raw);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
};

describe("config", () => {
  test("applies the defaults the Owner accepted", () => {
    const c = parseConfig(valid());
    expect(c.pollIntervalSec).toBe(60);
    expect(c.limits).toEqual({
      maxRunning: 1,
      maxPlanners: 1,
      maxImplementers: 1,
      maxReviewers: 1,
      maxLiveSessions: 2,
      idleTimeoutMin: 30,
      maxWorktrees: 5,
      maxFeedbackRounds: 2,
    });
  });

  test("REQ-001-01 requires the Owner's login and numeric user id", () => {
    expect(issuesOf({ ...valid(), owner: { login: "octo" } })).toEqual([expect.stringContaining("owner.id")]);
    expect(issuesOf({ ...valid(), owner: { login: "octo", id: "42" } })).toEqual([expect.stringContaining("owner.id")]);
    expect(issuesOf({ ...valid(), owner: { login: "", id: 42 } })).toEqual([expect.stringContaining("owner.login")]);
  });

  test("REQ-001-01 requires at least one repository named owner/repo, without duplicates", () => {
    expect(issuesOf({ ...valid(), repos: [] })).toEqual([expect.stringContaining("repos")]);
    expect(issuesOf({ ...valid(), repos: [{ name: "app" }] })).toEqual([expect.stringContaining("repos.0.name")]);
    expect(issuesOf({ ...valid(), repos: [{ name: "octo/app" }, { name: "Octo/App" }] })).toEqual([
      expect.stringContaining("duplicate repository octo/app"),
    ]);
  });

  test("REQ-001-15 requires the GitHub App's id and private key path", () => {
    expect(issuesOf({ ...valid(), github: { appId: 7 } })).toEqual([expect.stringContaining("github.privateKeyPath")]);
    expect(issuesOf({ ...valid(), github: undefined })).toEqual([expect.stringContaining("github")]);
  });

  test("REQ-001-08 rejects limits that are not positive integers", () => {
    const issues = issuesOf({ ...valid(), limits: { maxRunning: 0, maxReviewers: 1.5, maxPlanners: -1 } });
    expect(issues).toHaveLength(3);
    expect(issues.join("\n")).toContain("limits.maxRunning");
    expect(issues.join("\n")).toContain("limits.maxReviewers");
    expect(issues.join("\n")).toContain("limits.maxPlanners");
  });

  test("REQ-001-08 allows zero feedback rounds", () => {
    expect(parseConfig({ ...valid(), limits: { maxFeedbackRounds: 0 } }).limits.maxFeedbackRounds).toBe(0);
  });

  test("REQ-001-20 rejects maxRunning above maxLiveSessions, since running sessions are live sessions", () => {
    expect(issuesOf({ ...valid(), limits: { maxRunning: 3, maxLiveSessions: 2 } })).toEqual([
      expect.stringContaining("limits.maxRunning"),
    ]);
  });

  test("REQ-001-22 requires a model for every Role and only known effort levels", () => {
    const { implementer: _, ...roles } = valid().roles;
    expect(issuesOf({ ...valid(), roles })).toEqual([expect.stringContaining("roles.implementer")]);
    expect(issuesOf({ ...valid(), roles: { ...valid().roles, planner: { model: "opus", effort: "turbo" } } })).toEqual([
      expect.stringContaining("roles.planner.effort"),
    ]);
  });

  test("REQ-001-22 rejects unknown keys so typos don't pass silently", () => {
    expect(issuesOf({ ...valid(), limits: { maxRuning: 2 } })).toEqual([expect.stringContaining("maxRuning")]);
  });

  test("reports every problem at once", () => {
    expect(issuesOf({ owner: {}, repos: [], roles: {} }).length).toBeGreaterThanOrEqual(6);
  });

  test("REQ-001-22 resolves a Role's model and effort, with the repository override winning", () => {
    const c = parseConfig({
      ...valid(),
      repos: [{ name: "octo/app", roles: { planner: { model: "sonnet" }, reviewer: { effort: "max" } } }],
    });
    expect(roleSettings(c, "octo/app", "planner")).toEqual({ model: "sonnet", effort: "high" });
    expect(roleSettings(c, "octo/app", "reviewer")).toEqual({ model: "opus", effort: "max" });
    expect(roleSettings(c, "OCTO/app", "implementer")).toEqual({ model: "sonnet" });
    expect(() => roleSettings(c, "octo/other", "planner")).toThrow("not configured");
  });

  test("loads and validates a config module's default export", async () => {
    const dir = `${import.meta.dir}/fixtures`;
    expect((await loadConfig(`${dir}/config.valid.ts`)).owner.login).toBe("octo");
    expect(loadConfig(`${dir}/config.invalid.ts`)).rejects.toThrow(ConfigError);
    expect(loadConfig(`${dir}/missing.ts`)).rejects.toThrow("config file not found");
  });
});
