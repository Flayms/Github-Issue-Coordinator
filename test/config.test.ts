import { describe, expect, test } from "bun:test";
import {
  autoMergeMode,
  ConfigError,
  deprecatedSettings,
  loadConfig,
  parseConfig,
  roleSettings,
} from "../src/config.ts";

const valid = () => ({
  owner: { login: "octo", id: 42 },
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
  test("REQ-003-07 the dashboard is on by default on 127.0.0.1:8080 without a token, and `dashboard: false` turns it off", () => {
    expect(parseConfig(valid()).dashboard).toEqual({ host: "127.0.0.1", port: 8080, githubLogin: {} });
    expect(parseConfig({ ...valid(), dashboard: {} }).dashboard).toEqual({
      host: "127.0.0.1",
      port: 8080,
      githubLogin: {},
    });
    expect(parseConfig({ ...valid(), dashboard: false }).dashboard).toBeUndefined();
    expect(issuesOf({ ...valid(), dashboard: true })).not.toEqual([]);
  });

  test("REQ-003-31 off loopback, a dashboard needs a token unless the GitHub sign-in is on", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1"])
      expect(issuesOf({ ...valid(), dashboard: { host, githubLogin: false } })).toEqual([]);
    for (const host of ["0.0.0.0", "100.64.0.1", "::", "example.com"]) {
      expect(issuesOf({ ...valid(), dashboard: { host, githubLogin: false } })).toEqual([
        "dashboard.tokenPath: required when the dashboard listens on a host other than loopback and the GitHub sign-in is off",
      ]);
      // The sign-in is on by default; until it is set up, the dashboard answers 503 (REQ-003-29).
      expect(issuesOf({ ...valid(), dashboard: { host } })).toEqual([]);
    }
    expect(
      issuesOf({ ...valid(), dashboard: { host: "0.0.0.0", tokenPath: "/etc/c/token", githubLogin: false } }),
    ).toEqual([]);
  });

  test("REQ-003-29 the GitHub sign-in is on by default; it takes a client id and a secret file together, or `false`", () => {
    const login = { clientId: "Ov23liAbc", clientSecretPath: "/etc/c/github-client-secret" };
    expect(parseConfig({ ...valid(), dashboard: { githubLogin: login } }).dashboard?.githubLogin).toEqual(login);
    expect(parseConfig({ ...valid(), dashboard: { githubLogin: false } }).dashboard?.githubLogin).toBe(false);
    expect(issuesOf({ ...valid(), dashboard: { githubLogin: { clientId: "Ov23liAbc" } } })).toEqual([
      "dashboard.githubLogin: set clientId and clientSecretPath together",
    ]);
    expect(issuesOf({ ...valid(), dashboard: { githubLogin: true } })).not.toEqual([]);
    expect(issuesOf({ ...valid(), dashboard: { githubLogin: { ...login, extra: 1 } } })).not.toEqual([]);
  });

  test("REQ-004-01 without accounts there is one implicit Account, Claude's default folder", () => {
    expect(parseConfig(valid()).accounts).toEqual([{ name: "default" }]);
    const c = parseConfig({
      ...valid(),
      accounts: [{ name: "main" }, { name: "spare", configDir: "/home/agent/.claude-spare" }],
    });
    expect(c.accounts).toEqual([{ name: "main" }, { name: "spare", configDir: "/home/agent/.claude-spare" }]);
  });

  test("REQ-004-01 Accounts need distinct names and folders, and at least one Account", () => {
    expect(issuesOf({ ...valid(), accounts: [] })).not.toEqual([]);
    expect(issuesOf({ ...valid(), accounts: [{ name: "a" }, { name: "a", configDir: "/x" }] })).toEqual([
      "accounts.1.name: duplicate Account a",
    ]);
    expect(issuesOf({ ...valid(), accounts: [{ name: "a" }, { name: "b" }] })).toEqual([
      "accounts.1.configDir: same folder as Account a",
    ]);
    expect(
      issuesOf({
        ...valid(),
        accounts: [
          { name: "a", configDir: "/x" },
          { name: "b", configDir: "/x/" },
        ],
      }),
    ).toEqual(["accounts.1.configDir: same folder as Account a"]);
    expect(issuesOf({ ...valid(), accounts: [{ name: "a b" }] })).not.toEqual([]);
  });

  test("applies the defaults the Owner accepted", () => {
    const c = parseConfig(valid());
    expect(c.pollIntervalSec).toBe(60);
    expect(c.stateDir).toBe(".coordinator");
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

  test("REQ-005-02 needs no GitHub App: the token comes from gh, and App settings are refused", () => {
    expect(parseConfig(valid()).github.commitAuthor).toEqual({ name: "Claude", email: "noreply@anthropic.com" });
    const author = { name: "Bot", email: "bot@example.com" };
    expect(parseConfig({ ...valid(), github: { commitAuthor: author } }).github.commitAuthor).toEqual(author);
    expect(issuesOf({ ...valid(), github: { appId: 7, privateKeyPath: "/k.pem" } }).join("\n")).toContain("appId");
  });

  test("REQ-005-01 repositories have no sandbox domains any more", () => {
    expect(issuesOf({ ...valid(), repos: [{ name: "octo/app", sandboxDomains: ["pypi.org"] }] }).join("\n")).toContain(
      "sandboxDomains",
    );
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

  test("REQ-001-65 autoMerge is evaluated by default, set globally, and a repository's own value wins", () => {
    expect(autoMergeMode(parseConfig(valid()), "octo/app")).toBe("evaluated");
    expect(autoMergeMode(parseConfig({ ...valid(), autoMerge: "off" }), "octo/app")).toBe("off");
    const c = parseConfig({
      ...valid(),
      autoMerge: "evaluated",
      repos: [{ name: "octo/app", autoMerge: "all" }, { name: "octo/lib" }, { name: "octo/web", autoMerge: "off" }],
    });
    expect(autoMergeMode(c, "OCTO/app")).toBe("all");
    expect(autoMergeMode(c, "octo/lib")).toBe("evaluated");
    expect(autoMergeMode(c, "octo/web")).toBe("off");
    expect(() => autoMergeMode(c, "octo/other")).toThrow("not configured");
  });

  test("REQ-001-65 the deprecated `risk-evaluated` is read as `evaluated`, globally and per repository, and named as deprecated", () => {
    const raw = {
      ...valid(),
      autoMerge: "risk-evaluated",
      repos: [{ name: "octo/app", autoMerge: "risk-evaluated" }, { name: "octo/lib" }],
    };
    const c = parseConfig(raw);
    expect(c.autoMerge).toBe("evaluated");
    expect(autoMergeMode(c, "octo/app")).toBe("evaluated");
    expect(autoMergeMode(c, "octo/lib")).toBe("evaluated");
    expect(deprecatedSettings(raw)).toEqual([
      'autoMerge: "risk-evaluated" is now "evaluated"',
      'repos.0.autoMerge: "risk-evaluated" is now "evaluated"',
    ]);
    expect(deprecatedSettings({ ...valid(), autoMerge: "evaluated" })).toEqual([]);
    expect(deprecatedSettings(undefined)).toEqual([]);
  });

  test("REQ-001-65 rejects an unknown autoMerge mode, globally and per repository", () => {
    expect(issuesOf({ ...valid(), autoMerge: "risk" })).toEqual([expect.stringContaining("autoMerge")]);
    expect(issuesOf({ ...valid(), repos: [{ name: "octo/app", autoMerge: true }] })).toEqual([
      expect.stringContaining("repos.0.autoMerge"),
    ]);
  });

  test("loads and validates a config module's default export", async () => {
    const dir = `${import.meta.dir}/fixtures`;
    expect((await loadConfig(`${dir}/config.valid.ts`)).owner.login).toBe("octo");
    expect(loadConfig(`${dir}/config.invalid.ts`)).rejects.toThrow(ConfigError);
    expect(loadConfig(`${dir}/missing.ts`)).rejects.toThrow("config file not found");
  });
});
