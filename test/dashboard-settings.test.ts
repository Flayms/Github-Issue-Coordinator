import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigInput } from "../src/config.ts";
import type { TickSnapshot } from "../src/coordinator.ts";
import { formToken, newSession } from "../src/dashboard/auth.ts";
import { type DashboardServer, startDashboard } from "../src/dashboard/server.ts";
import { LiveConfig, OVERRIDES_FILE } from "../src/overrides.ts";

const OWNER_ID = 42;
const NOW = new Date("2026-11-15T10:01:00Z");
const SECRETS = { clientId: "Ov23liClient", clientSecret: "client-s3cret", sessionKey: "a".repeat(64) };
const LOGIN = { clientId: SECRETS.clientId, clientSecretPath: "/etc/c/github-client-secret" };
const TOKEN = "s3cret-token-value";
const SESSION = newSession(SECRETS.sessionKey, OWNER_ID, NOW);
const FORM_TOKEN = formToken(SECRETS.sessionKey, SESSION);

const snap: TickSnapshot = {
  finishedAt: "2026-11-15T10:00:00.000Z",
  pausedUntil: null,
  accounts: [],
  repos: [{ repo: "octo/app", error: null, issues: [], pulls: [], worktrees: 0 }],
  sessions: [],
  queue: [],
  events: [],
};

let servers: DashboardServer[] = [];
let dirs: string[] = [];
afterEach(() => {
  for (const s of servers) s.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  servers = [];
  dirs = [];
});

const start = (opts: { githubLogin?: false; token?: string } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "settings-"));
  dirs.push(dir);
  const raw: ConfigInput = {
    owner: { login: "octo", id: OWNER_ID },
    stateDir: dir,
    limits: { maxRunning: 2, maxLiveSessions: 3 },
    roles: {
      planner: { model: "opus", effort: "high" },
      implementer: { model: "sonnet" },
      reviewer: { model: "opus" },
    },
    repos: [{ name: "octo/app", setup: "bun install" }],
    dashboard: { port: 0, githubLogin: opts.githubLogin ?? LOGIN, ...(opts.token ? { tokenPath: "/t" } : {}) },
  };
  const settings = new LiveConfig(raw, "config.ts");
  const server = startDashboard({
    config: settings.base,
    settings,
    token: opts.token,
    login: opts.githubLogin === false ? undefined : SECRETS,
    snapshot: () => snap,
    log: () => {},
    now: () => NOW,
  });
  if (server) servers.push(server);
  return { settings, path: join(dir, OVERRIDES_FILE), url: `http://127.0.0.1:${server?.port}` };
};

const owner = { cookie: `coordinator_session=${SESSION}`, "sec-fetch-site": "same-origin" };

/** The fields that offer a Reset: the values of the `reset` buttons. */
const resets = (html: string) =>
  [...html.matchAll(/<button [^>]*>/g)]
    .map(([b]) => b)
    .filter((b) => b.includes('name="reset"'))
    .map((b) => /value="([^"]*)"/.exec(b)?.[1]);

const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = owner) =>
  fetch(`${url}/config`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

describe("dashboard settings", () => {
  test("REQ-003-36 the signed-in Owner gets the editable settings as a form with a form token", async () => {
    const { url } = start();
    const res = await fetch(`${url}/config`, { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<form [^>]*action="\/config" method="post"/);
    expect(html).toContain(`name="formToken" value="${FORM_TOKEN}"`);
    for (const name of [
      "pollIntervalSec",
      "checksGraceSeconds",
      "limits.maxRunning",
      "limits.maxFeedbackRounds",
      "roles.planner.model",
      "roles.planner.effort",
      "repos.octo/app.roles.reviewer.model",
      "repos.octo/app.roles.reviewer.effort",
      "autoMerge",
      "repos.octo/app.autoMerge",
    ])
      expect(html).toContain(`name="${name}"`);
    // The page doesn't refresh itself while it shows the form, so entered values stay.
    expect(html).not.toContain("data-reload");
    expect(html).not.toMatch(/http-equiv="refresh"/i);
    expect(html).toContain("No refresh while you edit");
    // Not editable: no field for setup commands, repositories, Accounts or access.
    expect(html).not.toMatch(/name="(repos\.[^"]*\.setup|accounts[^"]*|dashboard[^"]*|stateDir|owner[^"]*)"/);
  });

  test("REQ-003-07 / REQ-003-36 a token gives the Config page read-only, without a form", async () => {
    const { url } = start({ token: TOKEN });
    const res = await fetch(`${url}/config`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('action="/config"');
    expect(html).not.toContain('name="limits.maxRunning"');
    expect(html).toContain("data-reload");
  });

  test("REQ-003-36 saving writes the values that differ from config.ts and applies them at once", async () => {
    const { url, settings, path } = start();
    const res = await post(url, {
      formToken: FORM_TOKEN,
      pollIntervalSec: "30",
      "limits.maxRunning": "1",
      "limits.maxLiveSessions": "3",
      "roles.planner.model": "opus",
      "roles.planner.effort": "",
      "repos.octo/app.roles.reviewer.model": "sonnet",
      "repos.octo/app.roles.reviewer.effort": "max",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/config?saved=1");
    expect(settings.current.pollIntervalSec).toBe(30);
    expect(settings.current.limits.maxRunning).toBe(1);
    expect(settings.current.roles.planner).toEqual({ model: "opus" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      pollIntervalSec: 30,
      limits: { maxRunning: 1 },
      roles: { planner: { effort: null } },
      repos: { "octo/app": { roles: { reviewer: { model: "sonnet", effort: "max" } } } },
    });

    const page = await (await fetch(`${url}/config?saved=1`, { headers: { cookie: owner.cookie } })).text();
    expect(page).toContain("Saved. The Coordinator uses the new settings from its next tick on.");
    expect(page).toContain("Polling 1 repository every 30 s");
    // A changed field says so, with config.ts's value, and offers a Reset.
    expect(resets(page)).toEqual([
      "pollIntervalSec",
      "limits.maxRunning",
      "roles.planner.effort",
      "repos.octo/app.roles.reviewer.model",
      "repos.octo/app.roles.reviewer.effort",
    ]);
    expect(page).toContain("config.ts: 2");
  });

  test("REQ-003-36 autoMerge is a select globally and per repository, and saving it applies at once", async () => {
    const { url, settings, path } = start();
    const page = async () => (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    const select = (html: string, name: string) =>
      new RegExp(`<select [^>]*name="${name.replace(/[./]/g, "\\$&")}"[^>]*>(.*?)</select>`).exec(html)?.[1] ?? "";
    const options = (html: string) =>
      [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
    const before = await page();
    expect(options(select(before, "autoMerge"))).toEqual([
      ["off", "off"],
      ["evaluated", "evaluated (low risk only)"],
      ["all", "all"],
    ]);
    expect(options(select(before, "repos.octo/app.autoMerge"))).toEqual([
      ["", "global (evaluated)"], // REQ-001-65: the default
      ["off", "off"],
      ["evaluated", "evaluated (low risk only)"],
      ["all", "all"],
    ]);

    const res = await post(url, { formToken: FORM_TOKEN, autoMerge: "off", "repos.octo/app.autoMerge": "all" });
    expect(res.status).toBe(303);
    expect(settings.current.autoMerge).toBe("off");
    expect(settings.current.repos[0]?.autoMerge).toBe("all");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      autoMerge: "off",
      repos: { "octo/app": { autoMerge: "all" } },
    });
    const after = await page();
    expect(select(after, "autoMerge")).toMatch(/<option value="off" selected/);
    expect(select(after, "repos.octo/app.autoMerge")).toMatch(/<option value="all" selected/);
    expect(resets(after)).toEqual(["autoMerge", "repos.octo/app.autoMerge"]);
    expect(after).toContain("config.ts: evaluated");
    expect(after).toContain("config.ts: the global mode");

    // Back to the global mode: the repository's override goes away.
    await post(url, { formToken: FORM_TOKEN, autoMerge: "off", "repos.octo/app.autoMerge": "" });
    expect(settings.overrides).toEqual({ autoMerge: "off" });
    expect(settings.current.repos[0]?.autoMerge).toBeUndefined();

    const bad = await post(url, { formToken: FORM_TOKEN, autoMerge: "risky" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("autoMerge:");
    expect(settings.current.autoMerge).toBe("off");
  });

  test("REQ-003-36 an invalid value shows the error, keeps the entered values and saves nothing", async () => {
    const { url, settings, path } = start();
    const res = await post(url, { formToken: FORM_TOKEN, "limits.maxRunning": "5", pollIntervalSec: "abc" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Nothing was saved");
    expect(html).toContain("pollIntervalSec: must be a whole number");
    expect(html).toContain('name="limits.maxRunning" value="5"');
    expect(settings.current.limits.maxRunning).toBe(2);
    expect(existsSync(path)).toBe(false);

    const tooMany = await post(url, { formToken: FORM_TOKEN, "limits.maxRunning": "5" });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.text()).toContain("limits.maxRunning: must not exceed maxLiveSessions");
    expect(existsSync(path)).toBe(false);
  });

  test("REQ-003-36 Reset removes a field's override and keeps the other saved ones", async () => {
    const { url, settings } = start();
    settings.save({ limits: { maxRunning: 1 }, pollIntervalSec: 30 });
    const res = await post(url, { formToken: FORM_TOKEN, reset: "limits.maxRunning", pollIntervalSec: "99" });
    expect(res.status).toBe(303);
    expect(settings.overrides).toEqual({ pollIntervalSec: 30 });
    expect(settings.current.limits.maxRunning).toBe(2);
  });

  test("REQ-003-07 a POST without the form token, with a wrong one, or from another site is refused", async () => {
    const { url, settings, path } = start();
    const fields = { "limits.maxRunning": "1" };
    for (const [body, headers] of [
      [fields, owner],
      [{ ...fields, formToken: "0".repeat(43) }, owner],
      [{ ...fields, formToken: formToken("b".repeat(64), SESSION) }, owner],
      [
        { ...fields, formToken: FORM_TOKEN },
        { ...owner, "sec-fetch-site": "cross-site" },
      ],
      [
        { ...fields, formToken: FORM_TOKEN },
        { ...owner, "sec-fetch-site": "same-site" },
      ],
    ] as const) {
      const res = await post(url, body, headers);
      expect(res.status).toBe(403);
    }
    expect(settings.current.limits.maxRunning).toBe(2);
    expect(existsSync(path)).toBe(false);
  });

  test("REQ-003-07 a token never saves settings; without any access a POST gets 401", async () => {
    const { url, settings, path } = start({ token: TOKEN });
    const fields = { "limits.maxRunning": "1", formToken: FORM_TOKEN };
    const viaBearer = await post(url, fields, { authorization: `Bearer ${TOKEN}`, "sec-fetch-site": "same-origin" });
    expect(viaBearer.status).toBe(403);
    const viaCookie = await post(url, fields, {
      cookie: `coordinator_dashboard=${TOKEN}`,
      "sec-fetch-site": "same-origin",
    });
    expect(viaCookie.status).toBe(403);
    const anonymous = await post(url, fields, { "sec-fetch-site": "same-origin" });
    expect(anonymous.status).toBe(401);
    expect(settings.current.limits.maxRunning).toBe(2);
    expect(existsSync(path)).toBe(false);
  });

  test("REQ-003-07 with the GitHub sign-in off no one can save settings", async () => {
    const { url, settings } = start({ githubLogin: false });
    const res = await post(url, { "limits.maxRunning": "1", formToken: FORM_TOKEN });
    expect(res.status).toBe(403);
    expect(settings.current.limits.maxRunning).toBe(2);
    expect(await (await fetch(`${url}/config`)).text()).not.toContain('action="/config"');
  });
});
