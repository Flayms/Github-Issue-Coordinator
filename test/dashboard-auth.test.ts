import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigInput, parseConfig } from "../src/config.ts";
import type { TickSnapshot } from "../src/coordinator.ts";
import { loadDashboardLogin } from "../src/dashboard/auth.ts";
import { type DashboardServer, startDashboard } from "../src/dashboard/server.ts";
import { fakeFetch } from "./support/fake-fetch.ts";

const OWNER_ID = 42;
const base: ConfigInput = {
  owner: { login: "octo", id: OWNER_ID },
  roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app" }],
};
const LOGIN = { clientId: "Ov23liClient", clientSecretPath: "/etc/c/github-client-secret" };
const SECRETS = { clientId: LOGIN.clientId, clientSecret: "client-s3cret", sessionKey: "a".repeat(64) };
const TOKEN = "s3cret-token-value";
const ACCESS_TOKEN = "gho_user_access_token";
const DAY = 24 * 3600 * 1000;

const snap: TickSnapshot = {
  finishedAt: "2026-11-15T10:00:00.000Z",
  pausedUntil: null,
  repos: [
    {
      repo: "octo/app",
      error: null,
      issues: [{ number: 5, title: "Fix login", labels: ["agent:proposed"], blockedBy: [] }],
      pulls: [],
      worktrees: 0,
    },
  ],
  sessions: [],
  queue: [],
  events: [],
};

let servers: DashboardServer[] = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

/** A faked GitHub: the code `good` belongs to the user with id `userId`; other codes are refused. */
const github = (userId = OWNER_ID, login = "octo") =>
  fakeFetch({
    "POST /login/oauth/access_token": (req) =>
      (req.body as { code?: string }).code === "good"
        ? { body: { access_token: ACCESS_TOKEN, token_type: "bearer", scope: "" } }
        : { body: { error: "bad_verification_code" } },
    "GET /user": (req) =>
      req.headers.get("authorization") === `Bearer ${ACCESS_TOKEN}`
        ? { body: { id: userId, login } }
        : { status: 401, body: { message: "Bad credentials" } },
  });

const start = (
  opts: {
    githubLogin?: false | Partial<typeof LOGIN>;
    login?: typeof SECRETS;
    token?: string;
    gh?: ReturnType<typeof github>;
    clock?: { now: Date };
  } = {},
) => {
  const logs: string[] = [];
  const calls = { snapshot: 0 };
  const gh = opts.gh ?? github();
  const config = parseConfig({
    ...base,
    dashboard: { port: 0, githubLogin: opts.githubLogin ?? LOGIN, ...(opts.token ? { tokenPath: "/t" } : {}) },
  });
  const server = startDashboard({
    config,
    token: opts.token,
    login: "login" in opts ? opts.login : SECRETS,
    fetch: gh.fetch,
    snapshot: () => {
      calls.snapshot++;
      return snap;
    },
    log: (m) => logs.push(m),
    now: () => opts.clock?.now ?? new Date("2026-11-15T10:01:00Z"),
  });
  if (server) servers.push(server);
  return { server, logs, calls, gh, url: `http://127.0.0.1:${server?.port}` };
};

const cookieValue = (setCookie: string, name: string) => new RegExp(`(?:^|, )${name}=([^;]*)`).exec(setCookie)?.[1];

/** Runs the sign-in from a page request through the callback; returns the responses and the session cookie. */
async function signIn(url: string, path = "/", code = "good") {
  const first = await fetch(`${url}${path}`, { redirect: "manual" });
  const stateCookie = cookieValue(first.headers.get("set-cookie") ?? "", "coordinator_oauth") ?? "";
  const state = new URL(first.headers.get("location") ?? "http://x").searchParams.get("state") ?? "";
  const callback = await fetch(`${url}/auth/callback?code=${code}&state=${state}`, {
    redirect: "manual",
    headers: { cookie: `coordinator_oauth=${stateCookie}` },
  });
  const setCookie = callback.headers.get("set-cookie") ?? "";
  return { first, callback, setCookie, session: cookieValue(setCookie, "coordinator_session") };
}

describe("dashboard GitHub sign-in", () => {
  test("REQ-003-28 a browser without a session is sent to GitHub with a random state, kept in a short-lived Lax cookie", async () => {
    const { url, calls, gh } = start();
    const res = await fetch(`${url}/config?repo=octo%2Fapp`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(LOGIN.clientId);
    const state = location.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    // No scope: the sign-in reads only the public profile. The OAuth App's registered callback URL is used.
    expect(location.searchParams.has("scope")).toBe(false);
    expect(location.searchParams.has("redirect_uri")).toBe(false);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(cookieValue(setCookie, "coordinator_oauth")).toStartWith(`${state}.`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=600");
    expect(await res.text()).not.toContain("Fix login");
    expect(calls.snapshot).toBe(0);
    expect(gh.requests).toEqual([]);

    const other = await fetch(`${url}/`, { redirect: "manual" });
    expect(new URL(other.headers.get("location") ?? "").searchParams.get("state")).not.toBe(state);
  });

  test("REQ-003-28 a script's fetch or an asset without a session gets 401 instead of a redirect", async () => {
    const { url } = start();
    for (const [path, headers] of [
      ["/", { "sec-fetch-mode": "cors" }],
      ["/assets/dashboard.css", {}],
    ] as const) {
      const res = await fetch(`${url}${path}`, { redirect: "manual", headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  test("REQ-003-28 / REQ-003-29 the Owner signs in, comes back to the page asked for and gets a 30-day session", async () => {
    const { url, gh, logs } = start();
    const { callback, setCookie, session } = await signIn(url, "/config?repo=octo%2Fapp");
    expect(callback.status).toBe(200);
    const html = await callback.text();
    // A page that moves on by itself: a redirect would not carry the Strict cookie, since GitHub started the chain.
    expect(html).toContain('<meta http-equiv="refresh" content="0;url=/config?repo=octo%2Fapp">');
    expect(html).not.toContain(ACCESS_TOKEN);
    expect(session).toBeDefined();
    expect(session).not.toContain(ACCESS_TOKEN);
    const sessionCookie = setCookie.split(/, (?=coordinator_)/).find((c) => c.startsWith("coordinator_session=")) ?? "";
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Strict");
    expect(sessionCookie).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(sessionCookie).not.toContain("Secure");
    expect(cookieValue(setCookie, "coordinator_oauth")).toBe(""); // the state is used once

    // The only GitHub requests: the code exchange and GET /user.
    expect(gh.requests.map((r) => `${r.method} ${r.url.origin}${r.url.pathname}`)).toEqual([
      "POST https://github.com/login/oauth/access_token",
      "GET https://api.github.com/user",
    ]);
    expect(gh.requests[0]?.body).toEqual({
      client_id: SECRETS.clientId,
      client_secret: SECRETS.clientSecret,
      code: "good",
    });
    expect(logs.join("\n")).toContain("dashboard: octo signed in");

    const page = await fetch(`${url}/`, { headers: { cookie: `coordinator_session=${session}` } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Fix login");
  });

  test("REQ-003-29 another GitHub user gets 403, no session and no dashboard content", async () => {
    const { url, calls, logs } = start({ gh: github(7, "mallory") });
    const { callback, session } = await signIn(url);
    expect(callback.status).toBe(403);
    expect(session).toBeUndefined();
    expect(await callback.text()).not.toContain("Fix login");
    expect(calls.snapshot).toBe(0);
    expect(logs.join("\n")).toContain("dashboard: refused the GitHub sign-in of mallory (7)");
  });

  test("REQ-003-29 a wrong or missing state gets 400 and asks GitHub nothing", async () => {
    const { url, gh } = start();
    const first = await fetch(`${url}/`, { redirect: "manual" });
    const stateCookie = cookieValue(first.headers.get("set-cookie") ?? "", "coordinator_oauth") ?? "";
    const state = new URL(first.headers.get("location") ?? "").searchParams.get("state");
    for (const [query, cookie] of [
      [`code=good&state=${"0".repeat(64)}`, `coordinator_oauth=${stateCookie}`],
      ["code=good", `coordinator_oauth=${stateCookie}`],
      [`code=good&state=${state}`, ""],
      [`state=${state}`, `coordinator_oauth=${stateCookie}`],
    ] as const) {
      const res = await fetch(`${url}/auth/callback?${query}`, { redirect: "manual", headers: { cookie } });
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie") ?? "").not.toContain("coordinator_session=v");
    }
    expect(gh.requests).toEqual([]);
  });

  test("REQ-003-29 a code GitHub refuses gets 400; GitHub out of reach gets 502 and is logged", async () => {
    const { url } = start();
    expect((await signIn(url, "/", "stale")).callback.status).toBe(400);

    const down = start({
      gh: {
        requests: [],
        fetch: async () => {
          throw new Error("connect ETIMEDOUT");
        },
      },
    });
    const { callback, session } = await signIn(down.url);
    expect(callback.status).toBe(502);
    expect(session).toBeUndefined();
    expect(down.logs.join("\n")).toContain("ETIMEDOUT");
  });

  test("REQ-003-29 a tampered, expired or foreign session cookie sends the browser to GitHub again", async () => {
    const clock = { now: new Date("2026-11-15T10:01:00Z") };
    const { url } = start({ clock });
    const { session = "" } = await signIn(url);
    const ok = (cookie: string) =>
      fetch(`${url}/`, { redirect: "manual", headers: { cookie: `coordinator_session=${cookie}` } });
    expect((await ok(session)).status).toBe(200);

    const [v, id, exp, mac] = session.split(".");
    for (const bad of [
      `${v}.7.${exp}.${mac}`, // another user id
      `${v}.${id}.${(Number.parseInt(exp ?? "0", 36) + DAY).toString(36)}.${mac}`, // a longer life
      `${v}.${id}.${exp}.${mac?.slice(1)}x`, // a forged signature
      "garbage",
    ])
      expect((await ok(bad)).status).toBe(302);

    // Signed with another key, e.g. after the key file was rotated.
    const other = start({ login: { ...SECRETS, sessionKey: "b".repeat(64) } });
    expect(
      (await fetch(`${other.url}/`, { redirect: "manual", headers: { cookie: `coordinator_session=${session}` } }))
        .status,
    ).toBe(302);

    clock.now = new Date(clock.now.getTime() + 30 * DAY - 60_000);
    expect((await ok(session)).status).toBe(200);
    clock.now = new Date(clock.now.getTime() + 2 * 60_000);
    expect((await ok(session)).status).toBe(302);
  });

  test("REQ-003-29 the session survives a restart: the key is generated once in the state dir (0600) and reused", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-auth-"));
    try {
      const secretPath = join(dir, "client-secret");
      writeFileSync(secretPath, "client-s3cret\n");
      const config = parseConfig({ ...base, dashboard: { githubLogin: { ...LOGIN, clientSecretPath: secretPath } } });
      const first = loadDashboardLogin(config, dir);
      expect(first).toEqual({
        clientId: LOGIN.clientId,
        clientSecret: "client-s3cret",
        sessionKey: expect.any(String),
      });
      expect(first?.sessionKey).toMatch(/^[0-9a-f]{64}$/);
      const keyFile = join(dir, "dashboard-session.key");
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(keyFile, "utf8").trim()).toBe(first?.sessionKey ?? "");
      expect(loadDashboardLogin(config, dir)?.sessionKey).toBe(first?.sessionKey ?? "");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-003-29 a restarted server accepts the session signed before, unless owner.id changed", async () => {
    const { url } = start();
    const { session } = await signIn(url);
    const restarted = start();
    const res = await fetch(`${restarted.url}/`, { headers: { cookie: `coordinator_session=${session}` } });
    expect(res.status).toBe(200);

    // A session belongs to the Owner it was made for: a config with another owner.id doesn't take it.
    const logs: string[] = [];
    const otherOwner = startDashboard({
      config: parseConfig({ ...base, owner: { login: "else", id: 43 }, dashboard: { port: 0, githubLogin: LOGIN } }),
      login: SECRETS,
      snapshot: () => snap,
      log: (m) => logs.push(m),
    });
    if (otherOwner) servers.push(otherOwner);
    const moved = await fetch(`http://127.0.0.1:${otherOwner?.port}/`, {
      redirect: "manual",
      headers: { cookie: `coordinator_session=${session}` },
    });
    expect(moved.status).toBe(302);
  });

  test("REQ-003-28 the Coordinator refuses to start with an unreadable or empty client secret; off or not set up needs none", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-auth-"));
    try {
      const at = (clientSecretPath: string) =>
        parseConfig({ ...base, dashboard: { githubLogin: { ...LOGIN, clientSecretPath } } });
      expect(() => loadDashboardLogin(at(join(dir, "missing")), dir)).toThrow(
        "cannot read the GitHub client secret at",
      );
      writeFileSync(join(dir, "empty"), " \n");
      expect(() => loadDashboardLogin(at(join(dir, "empty")), dir)).toThrow("the GitHub client secret file is empty");
      expect(loadDashboardLogin(parseConfig(base), dir)).toBeUndefined();
      expect(loadDashboardLogin(parseConfig({ ...base, dashboard: { githubLogin: false } }), dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-003-28 the sign-in is on by default: until it is set up, the pages answer 503 and say how", async () => {
    const { url, logs, calls } = start({ githubLogin: {}, login: undefined });
    const res = await fetch(`${url}/`, { redirect: "manual" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("dashboard.githubLogin");
    expect(calls.snapshot).toBe(0);
    expect(logs.join("\n")).toContain("the GitHub sign-in is not set up");
  });

  test("REQ-003-30 Sign out ends the session and shows a page to sign in again; a cross-site POST is refused", async () => {
    const { url } = start();
    const { session } = await signIn(url);
    const cross = await fetch(`${url}/auth/logout`, {
      method: "POST",
      headers: { cookie: `coordinator_session=${session}`, "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);

    const out = await fetch(`${url}/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: `coordinator_session=${session}`, "sec-fetch-site": "same-origin" },
    });
    expect(out.status).toBe(200);
    const setCookie = out.headers.get("set-cookie") ?? "";
    expect(cookieValue(setCookie, "coordinator_session")).toBe("");
    expect(setCookie).toContain("Max-Age=0");
    const html = await out.text();
    expect(html).toContain("Signed out");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Fix login");
    expect((await fetch(`${url}/auth/logout`)).status).toBe(405);
  });

  test("REQ-003-30 the token still works next to the sign-in (Bearer, ?token= and its cookie), also before it is set up", async () => {
    for (const opts of [{ token: TOKEN }, { token: TOKEN, githubLogin: {}, login: undefined }]) {
      const { url } = start(opts);
      const res = await fetch(`${url}/`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Fix login");
      const viaQuery = await fetch(`${url}/?token=${TOKEN}`, { redirect: "manual" });
      expect(viaQuery.status).toBe(303);
      const tokenCookie = cookieValue(viaQuery.headers.get("set-cookie") ?? "", "coordinator_dashboard");
      expect(tokenCookie).toBe(TOKEN);
      const browser = await fetch(`${url}/config`, { headers: { cookie: `coordinator_dashboard=${tokenCookie}` } });
      expect(browser.status).toBe(200);
      const wrong = await fetch(`${url}/`, { redirect: "manual", headers: { authorization: "Bearer wrong" } });
      expect(wrong.status).not.toBe(200);
    }
  });

  test("REQ-003-29 behind HTTPS (X-Forwarded-Proto) the session cookie is Secure", async () => {
    const { url } = start();
    const first = await fetch(`${url}/`, { redirect: "manual" });
    const stateCookie = cookieValue(first.headers.get("set-cookie") ?? "", "coordinator_oauth");
    const state = new URL(first.headers.get("location") ?? "").searchParams.get("state");
    const res = await fetch(`${url}/auth/callback?code=good&state=${state}`, {
      headers: { cookie: `coordinator_oauth=${stateCookie}`, "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("REQ-003-07 with the sign-in, the CSP lets the page post only its own Sign out form", async () => {
    const { url } = start();
    const csp = (await fetch(`${url}/`, { redirect: "manual" })).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self'");
  });
});
