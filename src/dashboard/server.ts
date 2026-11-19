/**
 * Dashboard server (spec 003), inside the Coordinator process. It serves the last tick's snapshot, the
 * sessions' transcripts read for the Now line (REQ-003-42), and the Timings page the recorded Timings
 * (REQ-003-34): no store writes, and no GitHub calls besides the sign-in's (REQ-003-07, REQ-003-08). Its one write is the Owner's Settings overrides (REQ-003-36).
 */
import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { TickSnapshot } from "../coordinator.ts";
import type { Fetch } from "../github/http.ts";
import type { SettingsEditor } from "../overrides.ts";
import { TranscriptReader } from "../transcript.ts";
import { asset } from "./assets.ts";
import {
  authorizeUrl,
  checkState,
  type DashboardLogin,
  formToken,
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
import { type SettingField, type SettingsForm, saveSettings, settingFields } from "./settings-form.ts";
import { type TimingSource, timingsView } from "./timings.ts";
import { renderTimings } from "./timings-html.tsx";
import { type DashboardView, dashboardView } from "./view.ts";

const COOKIE = "coordinator_dashboard";
const COOKIE_MAX_AGE_SEC = 365 * 24 * 3600;
const CALLBACK = "/auth/callback";
const LOGOUT = "/auth/logout";

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const ASSET_PREFIX = "/assets/";
/** The Config form is a few kB; anything larger is refused before it is read. */
const MAX_BODY_BYTES = 64 * 1024;
/** Asset URLs carry a content hash (`?v=`), so a day of caching never shows a stale file after an update. */
const ASSET_CACHE = "private, max-age=86400";

export interface DashboardDeps {
  /** `config.ts`; the pages show `settings.current` when there are `settings`. */
  config: Config;
  /** The editable settings (REQ-003-36); without them the Config page is read-only. */
  settings?: SettingsEditor;
  /** The configured token (REQ-003-07); without one, no request needs one. */
  token?: string;
  /** The GitHub sign-in's secrets (REQ-003-29); absent while it is off or not set up. */
  login?: DashboardLogin;
  /** For the sign-in's two GitHub requests; the global fetch by default. */
  fetch?: Fetch;
  snapshot: () => TickSnapshot | undefined;
  /** The models the sessions reported (REQ-001-29), for the Config page's model choices (REQ-003-40). */
  reportedModels?: () => string[];
  /** The recorded Timings for the Timings page, read only (REQ-003-34); the store in the Coordinator. */
  timings?: TimingSource;
  /** Reads the sessions' transcripts for the Now line and Open chat (REQ-003-42, REQ-003-43); its own by default. */
  transcripts?: TranscriptReader;
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
  // One reader per server, so its scans for the Remote Control URL are remembered across requests (REQ-003-43).
  const deps = { ...d, transcripts: d.transcripts ?? new TranscriptReader() };
  try {
    const server = Bun.serve({
      hostname: dash.host,
      port: dash.port,
      maxRequestBodySize: MAX_BODY_BYTES,
      fetch: (req) => handle(req, deps),
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
    // REQ-003-29: on unless `githubLogin: false`; `d.login` is there once it is set up.
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
    // The Owner's session cookie when it is valid: only a session may save settings (REQ-003-07).
    let session: string | undefined;
    if (d.token || loginOn) {
      const presented = bearer(req) ?? cookie(req, COOKIE);
      const viaToken = d.token !== undefined && presented !== undefined && same(presented, d.token);
      const sessionCookie = cookie(req, SESSION_COOKIE);
      if (login && validSession(login.sessionKey, sessionCookie, d.config.owner.id, now)) session = sessionCookie;
      if (!viaToken && !session) return signInNeeded(req, url, loginOn, login);
    }
    if (url.pathname === "/config" && req.method === "POST" && d.settings)
      return await postConfig(req, url, d, d.settings, login, session, now);
    if (req.method !== "GET") return respond(405, "Method not allowed", { allow: "GET" });
    if (url.pathname.startsWith(ASSET_PREFIX)) {
      const a = asset(url.pathname.slice(ASSET_PREFIX.length));
      if (!a) return respond(404, "Not found");
      return respond(200, a.body, { "content-type": a.type, "cache-control": ASSET_CACHE });
    }
    const page = PAGES.get(url.pathname);
    if (!page) return respond(404, "Not found");
    // REQ-003-42: only the Overview shows the Now line, so only it reads transcripts, at request time.
    const reader = url.pathname === "/" ? d.transcripts : undefined;
    const view = dashboardView(d.snapshot(), d.settings?.current ?? d.config, now, {
      repo: url.searchParams.get("repo"),
      transcript: reader && ((path) => reader.read(path)),
    });
    const form = settingsForm(d, login, session, url.searchParams.get("saved") === "1");
    return respond(200, page(view, url, d, now, form), { "content-type": "text/html; charset=utf-8" });
  } catch (e) {
    d.log(`dashboard: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return respond(500, "Internal error");
  }
}

/** The Config form for the signed-in Owner (REQ-003-36); undefined for a token or without a sign-in. */
function settingsForm(
  d: DashboardDeps,
  login: DashboardLogin | undefined,
  session: string | undefined,
  saved: boolean,
  failed?: { errors: string[]; fields: SettingField[] },
): SettingsForm | undefined {
  if (!d.settings || !login || !session) return undefined;
  return {
    token: formToken(login.sessionKey, session),
    fields: failed?.fields ?? settingFields(d.settings.base, d.settings.current),
    errors: failed?.errors ?? [],
    saved,
    reportedModels: d.reportedModels?.() ?? [],
  };
}

/**
 * REQ-003-07 / REQ-003-36: saves the Config form; only the Owner's session, on this site, with the session's form
 * token. Saved: back to the page (303); invalid: the page with the errors and the entered values (400).
 */
async function postConfig(
  req: Request,
  url: URL,
  d: DashboardDeps,
  settings: SettingsEditor,
  login: DashboardLogin | undefined,
  session: string | undefined,
  now: Date,
): Promise<Response> {
  const site = req.headers.get("sec-fetch-site");
  if (!login || !session || (site !== null && site !== "same-origin"))
    return respond(403, "Forbidden: only the Owner's signed-in session can change settings.");
  const form = await req.formData().catch(() => undefined);
  const presented = form?.get("formToken");
  if (!form || typeof presented !== "string" || !same(presented, formToken(login.sessionKey, session)))
    return respond(403, "Forbidden: the form is out of date. Open the Config page again.");
  const result = saveSettings(settings, form);
  if (!result.errors.length) {
    d.log("dashboard: settings saved");
    return respond(303, "", { location: "/config?saved=1" });
  }
  const view = dashboardView(d.snapshot(), settings.current, now, { repo: url.searchParams.get("repo") });
  const page = renderConfig(view, settingsForm(d, login, session, false, result));
  return respond(400, page, { "content-type": "text/html; charset=utf-8" });
}

/** A browser opening a page goes to GitHub (REQ-003-29); scripts, assets and other methods get 401. */
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

/** REQ-003-30: only the Owner gets a session; the state is checked first and used once. */
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

/** REQ-003-31: ends the session (and a token cookie); a page, since `/` would sign in again right away. */
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

const NO_TIMINGS: TimingSource = { timedIssues: () => [], timings: () => [] };

/** The pages: the Overview, the Config page (REQ-003-05) and the Timings page (REQ-003-34); all plain GET links. */
const PAGES = new Map<
  string,
  (view: DashboardView, url: URL, d: DashboardDeps, now: Date, form: SettingsForm | undefined) => string
>([
  ["/", renderDashboard],
  ["/config", (view, _url, _d, _now, form) => renderConfig(view, form)],
  [
    "/timings",
    (view, url, d, now) =>
      renderTimings(
        view,
        timingsView({
          source: d.timings ?? NO_TIMINGS,
          pick: url.searchParams.get("issue"),
          includeOwner: url.searchParams.get("owner") === "1",
          now,
        }),
      ),
  ],
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
