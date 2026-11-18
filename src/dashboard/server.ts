/**
 * Read-only dashboard server (spec 003), inside the Coordinator process. It serves only the last
 * tick's snapshot: no store writes, and no GitHub calls besides the sign-in's (REQ-003-07, REQ-003-08).
 */
import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { TickSnapshot } from "../coordinator.ts";
import type { Fetch } from "../github/http.ts";
import { asset } from "./assets.ts";
import {
  authorizeUrl,
  checkState,
  type DashboardLogin,
  newSession,
  newState,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  STATE_COOKIE,
  STATE_MAX_AGE_SEC,
  same,
  stateCookieValue,
  validSession,
  whoSignedIn,
} from "./auth.ts";
import { renderConfig } from "./config-html.tsx";
import { renderDashboard } from "./html.tsx";
import { dashboardView } from "./view.ts";

const COOKIE = "coordinator_dashboard";
const COOKIE_MAX_AGE_SEC = 365 * 24 * 3600;
const CALLBACK = "/auth/callback";
const LOGOUT = "/auth/logout";

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const ASSET_PREFIX = "/assets/";
/** Asset URLs carry a content hash (`?v=`), so a day of caching never shows a stale file after an update. */
const ASSET_CACHE = "private, max-age=86400";

export interface DashboardDeps {
  config: Config;
  /** The configured token (REQ-003-07); without one, no request needs one. */
  token?: string;
  /** The GitHub sign-in's secrets (REQ-003-28); absent while it is off or not set up. */
  login?: DashboardLogin;
  /** For the sign-in's two GitHub requests; the global fetch by default. */
  fetch?: Fetch;
  snapshot: () => TickSnapshot | undefined;
  log: (message: string) => void;
  now?: () => Date;
}

export type DashboardServer = ReturnType<typeof Bun.serve>;

/** Reads `dashboard.tokenPath`; throws so the Coordinator refuses to start without a usable token. */
export function loadDashboardToken(config: Config): string | undefined {
  const path = config.dashboard?.tokenPath;
  if (!path) return undefined;
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`cannot read the dashboard token at ${path} (dashboard.tokenPath)`);
  }
  if (!token) throw new Error(`the dashboard token file is empty: ${path} (dashboard.tokenPath)`);
  return token;
}

const NOT_SET_UP =
  "the GitHub sign-in is not set up (dashboard.githubLogin); pages answer 503 until it is, or set githubLogin: false (docs/setup.md step 4)";

/** Starts the server unless the config turns it off (`dashboard: false`); a server that cannot listen is logged (REQ-003-08). */
export function startDashboard(d: DashboardDeps): DashboardServer | undefined {
  const dash = d.config.dashboard;
  if (!dash) return undefined;
  try {
    const server = Bun.serve({
      hostname: dash.host,
      port: dash.port,
      fetch: (req) => handle(req, d),
      error: (e) => {
        d.log(`dashboard: ${e.message}`);
        return respond(500, "Internal error");
      },
    });
    d.log(`dashboard on http://${dash.host}:${server.port}`);
    if (dash.githubLogin !== false && !d.login) d.log(`dashboard: ${NOT_SET_UP}`);
    return server;
  } catch (e) {
    d.log(`dashboard not started: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function respond(
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
  cookies: string[] = [],
): Response {
  const h = new Headers({ "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...headers });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(body, { status, headers: h });
}

async function handle(req: Request, d: DashboardDeps): Promise<Response> {
  try {
    const url = new URL(req.url);
    const now = d.now?.() ?? new Date();
    // REQ-003-28: on unless `githubLogin: false`; `d.login` is there once it is set up.
    const loginOn = d.config.dashboard?.githubLogin !== false;
    const login = loginOn ? d.login : undefined;
    if (login && url.pathname === CALLBACK) return await callback(req, url, login, d, now);
    if (loginOn && url.pathname === LOGOUT) return logout(req);
    const viaQuery = url.searchParams.get("token");
    if (d.token && viaQuery !== null) {
      if (!same(viaQuery, d.token)) return unauthorized();
      // Keep the token in a cookie and drop it from the address bar.
      return respond(303, "", { location: "/" }, [
        `${COOKIE}=${d.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}`,
      ]);
    }
    if (d.token || loginOn) {
      const presented = bearer(req) ?? cookie(req, COOKIE);
      const viaToken = d.token !== undefined && presented !== undefined && same(presented, d.token);
      const viaSession =
        login !== undefined && validSession(login.sessionKey, cookie(req, SESSION_COOKIE), d.config.owner.id, now);
      if (!viaToken && !viaSession) return signInNeeded(req, url, loginOn, login);
    }
    if (req.method !== "GET") return respond(405, "Method not allowed", { allow: "GET" });
    if (url.pathname.startsWith(ASSET_PREFIX)) {
      const a = asset(url.pathname.slice(ASSET_PREFIX.length));
      if (!a) return respond(404, "Not found");
      return respond(200, a.body, { "content-type": a.type, "cache-control": ASSET_CACHE });
    }
    const page = PAGES.get(url.pathname);
    if (!page) return respond(404, "Not found");
    const view = dashboardView(d.snapshot(), d.config, now, { repo: url.searchParams.get("repo") });
    return respond(200, page(view), { "content-type": "text/html; charset=utf-8" });
  } catch (e) {
    d.log(`dashboard: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return respond(500, "Internal error");
  }
}

/** A browser opening a page goes to GitHub (REQ-003-28); scripts, assets and other methods get 401. */
function signInNeeded(req: Request, url: URL, loginOn: boolean, login: DashboardLogin | undefined): Response {
  if (loginOn && !login) return respond(503, `Unavailable: ${NOT_SET_UP}.`);
  const mode = req.headers.get("sec-fetch-mode");
  if (!login || req.method !== "GET" || !PAGES.has(url.pathname) || (mode !== null && mode !== "navigate"))
    return unauthorized(login !== undefined);
  const state = newState();
  // Lax: the callback is a top-level navigation coming from github.com, which a Strict cookie would miss.
  return respond(302, "", { location: authorizeUrl(login.clientId, state) }, [
    `${STATE_COOKIE}=${stateCookieValue(state, url.pathname + url.search)}; HttpOnly; SameSite=Lax; Path=${CALLBACK}; Max-Age=${STATE_MAX_AGE_SEC}${secure(req, url)}`,
  ]);
}

/** REQ-003-29: only the Owner gets a session; the state is checked first and used once. */
async function callback(req: Request, url: URL, login: DashboardLogin, d: DashboardDeps, now: Date) {
  if (req.method !== "GET") return respond(405, "Method not allowed", { allow: "GET" });
  const clearState = `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=${CALLBACK}; Max-Age=0${secure(req, url)}`;
  const returnTo = checkState(cookie(req, STATE_COOKIE), url.searchParams.get("state"));
  const code = url.searchParams.get("code");
  if (!returnTo || !code)
    return respond(400, "Sign-in failed: it did not start here or took too long. Open the dashboard again.", {}, [
      clearState,
    ]);
  const result = await whoSignedIn(login, code, d.fetch ?? fetch);
  if (!result.ok) {
    d.log(`dashboard: GitHub sign-in failed: ${result.reason}`);
    return respond(result.status, `Sign-in failed: ${result.reason}. Open the dashboard again.`, {}, [clearState]);
  }
  const { user } = result;
  if (user.id !== d.config.owner.id) {
    d.log(`dashboard: refused the GitHub sign-in of ${user.login} (${user.id}), not the Owner`);
    return respond(403, "Forbidden: only the Owner can open this dashboard.", {}, [clearState]);
  }
  d.log(`dashboard: ${user.login} signed in`);
  const session = `${SESSION_COOKIE}=${newSession(login.sessionKey, user.id, now)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}${secure(req, url)}`;
  // A page that moves on, not a redirect: the browser leaves out a Strict cookie on a redirect chain GitHub started.
  const to = escapeHtml(returnTo);
  return notice(200, "Signed in", `<meta http-equiv="refresh" content="0;url=${to}">`, `<a href="${to}">Continue</a>`, [
    session,
    clearState,
  ]);
}

/** REQ-003-30: ends the session (and a token cookie); a page, since `/` would sign in again right away. */
function logout(req: Request): Response {
  if (req.method !== "POST") return respond(405, "Method not allowed", { allow: "POST" });
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return respond(403, "Forbidden");
  return notice(200, "Signed out", "", `Signed out. <a href="/">Sign in again</a>`, [
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  ]);
}

const notice = (status: number, title: string, head: string, body: string, cookies: string[]) =>
  respond(
    status,
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">${head}<title>${title} · Coordinator</title></head><body><p>${body}</p></body></html>\n`,
    { "content-type": "text/html; charset=utf-8" },
    cookies,
  );

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `; Secure` when the browser came over HTTPS, e.g. through `tailscale serve`. */
const secure = (req: Request, url: URL) =>
  url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";

/** The pages: the Overview and the Config page (REQ-003-05); both are plain GET links. */
const PAGES = new Map([
  ["/", renderDashboard],
  ["/config", renderConfig],
]);

const unauthorized = (login = false) =>
  respond(
    401,
    login
      ? "Unauthorized: open the dashboard in the browser to sign in with GitHub."
      : "Unauthorized: open the dashboard once with ?token=<your token>.",
  );

function bearer(req: Request): string | undefined {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  return m?.[1];
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
