import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigInput, extraInstructions } from "../src/config.ts";
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

const start = (
  opts: {
    githubLogin?: false;
    token?: string;
    roles?: ConfigInput["roles"];
    reportedModels?: string[];
    overrides?: object;
    instructions?: ConfigInput["instructions"];
    accounts?: ConfigInput["accounts"];
  } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "settings-"));
  dirs.push(dir);
  const raw: ConfigInput = {
    owner: { login: "octo", id: OWNER_ID },
    stateDir: dir,
    limits: { maxRunning: 2, maxLiveSessions: 3 },
    roles: opts.roles ?? {
      planner: { model: "opus", effort: "high" },
      implementer: { model: "sonnet" },
      reviewer: { model: "opus" },
    },
    repos: [{ name: "octo/app", setup: "bun install" }],
    ...(opts.instructions && { instructions: opts.instructions }),
    ...(opts.accounts && { accounts: opts.accounts }),
    dashboard: { port: 0, githubLogin: opts.githubLogin ?? LOGIN, ...(opts.token ? { tokenPath: "/t" } : {}) },
  };
  if (opts.overrides) writeFileSync(join(dir, OVERRIDES_FILE), JSON.stringify(opts.overrides));
  const settings = new LiveConfig(raw, "config.ts");
  const server = startDashboard({
    config: settings.base,
    settings,
    token: opts.token,
    login: opts.githubLogin === false ? undefined : SECRETS,
    snapshot: () => snap,
    ...(opts.reportedModels && { reportedModels: () => opts.reportedModels ?? [] }),
    log: () => {},
    now: () => NOW,
  });
  if (server) servers.push(server);
  return { settings, path: join(dir, OVERRIDES_FILE), url: `http://127.0.0.1:${server?.port}` };
};

/** The inside of the select named `name`. */
const selectOf = (html: string, name: string) =>
  new RegExp(`<select [^>]*name="${name.replace(/[./[\]]/g, "\\$&")}"[^>]*>(.*?)</select>`).exec(html)?.[1] ?? "";
/** `[value, label]` of each option. */
const optionsOf = (html: string) =>
  [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);

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

  test("REQ-003-40 a Role's model is a select of the Model catalogue, globally and in a repository", async () => {
    const { url } = start({ reportedModels: ["claude-opus-5-5", "claude-opus-4-6"] });
    const html = await (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    expect(html).not.toMatch(/<input [^>]*name="[^"]*\.model"/);
    const catalogue = [
      ["fable", "Fable (latest)"],
      ["opus", "Opus (latest) · now Opus 5.5"],
      ["sonnet", "Sonnet (latest)"],
      ["haiku", "Haiku (latest)"],
      ["claude-fable-5-2", "Fable 5.2"],
      ["claude-opus-5-5", "Opus 5.5"],
      ["claude-sonnet-5-5", "Sonnet 5.5"],
      ["claude-haiku-5-5", "Haiku 5.5"],
    ];
    const global = selectOf(html, "roles.planner.model");
    expect(optionsOf(global)).toEqual(catalogue);
    expect(global).toMatch(/<option value="opus" selected/);
    expect(optionsOf(selectOf(html, "repos.octo/app.roles.implementer.model"))).toEqual([
      ["", "global (Sonnet (latest))"],
      ...catalogue,
    ]);
  });

  test("REQ-003-40 a config.ts model outside the catalogue stays an option and saving keeps it", async () => {
    const { url, settings, path } = start({
      roles: { planner: { model: "opus[1m]" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
    });
    const html = await (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    const planner = selectOf(html, "roles.planner.model");
    expect(optionsOf(planner)[0]).toEqual(["opus[1m]", "Opus (latest), 1M context"]);
    expect(planner).toMatch(/<option value="opus\[1m\]" selected/);

    const res = await post(url, { formToken: FORM_TOKEN, "roles.planner.model": "opus[1m]", pollIntervalSec: "30" });
    expect(res.status).toBe(303);
    expect(settings.current.roles.planner.model).toBe("opus[1m]");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pollIntervalSec: 30 });
  });

  test("REQ-003-40 a model that is neither in the catalogue nor config.ts's is refused and nothing is saved", async () => {
    const { url, settings, path } = start();
    for (const [field, value] of [
      ["roles.planner.model", "gpt-4"],
      ["repos.octo/app.roles.reviewer.model", "opus[1m]"],
    ] as const) {
      const res = await post(url, { formToken: FORM_TOKEN, [field]: value, pollIntervalSec: "30" });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(`${field}: must be a model from the list`);
    }
    expect(settings.current.roles.planner.model).toBe("opus");
    expect(settings.current.pollIntervalSec).toBe(60);
    expect(existsSync(path)).toBe(false);

    const ok = await post(url, { formToken: FORM_TOKEN, "roles.planner.model": "claude-opus-5-5" });
    expect(ok.status).toBe(303);
    expect(settings.current.roles.planner.model).toBe("claude-opus-5-5");
  });

  test("REQ-003-40 a saved model outside the catalogue still loads, stays selected and other fields still save", async () => {
    const { url, settings } = start({ overrides: { roles: { reviewer: { model: "claude-opus-4-6" } } } });
    expect(settings.current.roles.reviewer.model).toBe("claude-opus-4-6");
    const html = await (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    const reviewer = selectOf(html, "roles.reviewer.model");
    expect(reviewer).toMatch(/<option value="claude-opus-4-6" selected[^>]*>Opus 4.6</);
    expect(html).toContain("config.ts: Opus (latest)");

    const res = await post(url, {
      formToken: FORM_TOKEN,
      "roles.reviewer.model": "claude-opus-4-6",
      pollIntervalSec: "30",
    });
    expect(res.status).toBe(303);
    expect(settings.current.pollIntervalSec).toBe(30);
    expect(settings.current.roles.reviewer.model).toBe("claude-opus-4-6");
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

  /** The text of the textarea named `name`, or undefined without one. */
  const textareaOf = (html: string, name: string) =>
    new RegExp(`<textarea [^>]*name="${name.replace(/[./]/g, "\\$&")}"[^>]*>([^<]*)</textarea>`, "s").exec(html)?.[1];

  test("REQ-003-44 each Role's Extra instructions are a textarea, globally and in each repository", async () => {
    const { url } = start({ instructions: { reviewer: "Be <brief>." } });
    const html = await (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    for (const role of ["planner", "implementer", "reviewer"]) {
      expect(textareaOf(html, `instructions.${role}`)).toBeDefined();
      expect(textareaOf(html, `repos.octo/app.instructions.${role}`)).toBe("");
    }
    expect(textareaOf(html, "instructions.reviewer")).toBe("Be &lt;brief&gt;.");
    expect(html).toContain("Added after the Role prompt");
    expect(html).toContain("At most 4,000 characters each");
  });

  test("REQ-003-44 saving Extra instructions stores them and applies them to sessions started from then on; Reset removes them", async () => {
    const { url, settings, path } = start({ instructions: { implementer: "Use pnpm." } });
    const res = await post(url, {
      formToken: FORM_TOKEN,
      "instructions.planner": "Always answer in German.\r\nUse {{x}} literally.",
      "repos.octo/app.instructions.planner": "Mention the ticket.",
      "instructions.implementer": "",
    });
    expect(res.status).toBe(303);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      instructions: { planner: "Always answer in German.\nUse {{x}} literally.", implementer: "" },
      repos: { "octo/app": { instructions: { planner: "Mention the ticket." } } },
    });
    expect(extraInstructions(settings.current, "octo/app", "planner")).toEqual([
      "Always answer in German.\nUse {{x}} literally.",
      "Mention the ticket.",
    ]);
    expect(extraInstructions(settings.current, "octo/app", "implementer")).toEqual([]);

    const page = await (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    expect(textareaOf(page, "instructions.planner")).toBe("Always answer in German.\nUse {{x}} literally.");
    expect(resets(page)).toEqual([
      "instructions.planner",
      "instructions.implementer",
      "repos.octo/app.instructions.planner",
    ]);

    await post(url, { formToken: FORM_TOKEN, reset: "instructions.implementer" });
    expect(extraInstructions(settings.current, "octo/app", "implementer")).toEqual(["Use pnpm."]);
    expect(settings.overrides.instructions).toEqual({ planner: "Always answer in German.\nUse {{x}} literally." });
  });

  test("REQ-003-44 Extra instructions over the size limit are refused, kept in the form, and nothing is saved", async () => {
    const { url, settings, path } = start();
    const long = "x".repeat(4_001);
    const res = await post(url, {
      formToken: FORM_TOKEN,
      pollIntervalSec: "30",
      "repos.octo/app.instructions.reviewer": long,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("repos.octo/app.instructions.reviewer: must be at most 4,000 characters");
    expect(textareaOf(html, "repos.octo/app.instructions.reviewer")).toBe(long);
    expect(settings.current.pollIntervalSec).toBe(60);
    expect(existsSync(path)).toBe(false);
  });

  test("REQ-003-44 a token sees the Extra instructions but gets no field to change them", async () => {
    const { url } = start({
      token: TOKEN,
      overrides: { instructions: { planner: "Always answer in German." } },
    });
    const html = await (await fetch(`${url}/config`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    expect(html).toContain("Extra instructions");
    expect(html).toContain("Always answer in German.");
    expect(html).not.toContain("<textarea");
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

describe("Model dropdown per Harness (spec 006)", () => {
  /** The labels of the select's option groups, in order. */
  const groupsOf = (select: string) => [...select.matchAll(/<optgroup label="([^"]*)"/g)].map((m) => m[1]);

  test("REQ-006-01 with Accounts of several Harnesses, the models are grouped by Harness", async () => {
    const { url } = start({ accounts: [{ name: "main" }, { name: "gpt", harness: "codex" }] });
    const html = await (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    const select = selectOf(html, "roles.reviewer.model");
    expect(groupsOf(select)).toEqual(["Claude Code · Latest", "Claude Code · Pinned", "Codex CLI"]);
    expect(optionsOf(select)).toContainEqual(["gpt-6.2-sol", "GPT-6.2-Sol"]);
  });

  test("REQ-006-07 with an Antigravity Account, its Gemini models are offered", async () => {
    const { url } = start({ accounts: [{ name: "main" }, { name: "gemini", harness: "antigravity" }] });
    const html = await (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    const select = selectOf(html, "roles.reviewer.model");
    expect(groupsOf(select)).toEqual(["Claude Code · Latest", "Claude Code · Pinned", "Antigravity CLI"]);
    expect(optionsOf(select)).toContainEqual(["gemini-4-neon", "Gemini 4 Neon"]);
  });

  test("REQ-006-01 only Harnesses with an Account are offered; with Claude alone the dropdown stays as it was", async () => {
    const { url } = start();
    const html = await (await fetch(`${url}/config`, { headers: { cookie: owner.cookie } })).text();
    const select = selectOf(html, "roles.reviewer.model");
    expect(groupsOf(select)).toEqual(["Latest", "Pinned"]);
    expect(select).not.toContain("gpt-");
  });
});
