/**
 * "Sign in with GitHub" for the dashboard (REQ-003-29..31): the OAuth web flow of a GitHub OAuth App, and a
 * signed session cookie for the Owner. The user's access token is used for `GET /user` only and then dropped.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, githubLoginOf } from "../config.ts";
import { API, baseHeaders, type Fetch } from "../github/http.ts";

/** What the server needs to run the sign-in; loaded once at startup. */
export interface DashboardLogin {
  clientId: string;
  clientSecret: string;
  /** Signs the session cookies; kept in the state dir so a restart keeps the Owner signed in. */
  sessionKey: string;
}

export const SESSION_COOKIE = "coordinator_session";
export const STATE_COOKIE = "coordinator_oauth";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 3600;
export const STATE_MAX_AGE_SEC = 600;
export const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const SESSION_KEY_FILE = "dashboard-session.key";
const SESSION_VERSION = "v1";

/**
 * Reads the client secret and the session key (generated on first use, 0600). Undefined when the sign-in is off or
 * not set up yet; throws when the secret can't be used, so the Coordinator refuses to start (REQ-003-29).
 */
export function loadDashboardLogin(config: Config, stateDir: string): DashboardLogin | undefined {
  const login = githubLoginOf(config);
  if (!login) return undefined;
  let clientSecret: string;
  try {
    clientSecret = readFileSync(login.clientSecretPath, "utf8").trim();
  } catch {
    throw new Error(
      `cannot read the GitHub client secret at ${login.clientSecretPath} (dashboard.githubLogin.clientSecretPath)`,
    );
  }
  if (!clientSecret)
    throw new Error(
      `the GitHub client secret file is empty: ${login.clientSecretPath} (dashboard.githubLogin.clientSecretPath)`,
    );
  return { clientId: login.clientId, clientSecret, sessionKey: sessionKey(stateDir) };
}

function sessionKey(stateDir: string): string {
  const path = join(stateDir, SESSION_KEY_FILE);
  try {
    const key = readFileSync(path, "utf8").trim();
    if (key) return key;
  } catch {}
  const key = randomBytes(32).toString("hex");
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return key;
}

/** A random `state` for the authorize URL, to be kept in the state cookie and checked on the callback. */
export const newState = (): string => randomBytes(32).toString("hex");

export const authorizeUrl = (clientId: string, state: string): string =>
  `${AUTHORIZE_URL}?${new URLSearchParams({ client_id: clientId, state })}`;

/** The state cookie's value: the state and the page to come back to. */
export const stateCookieValue = (state: string, returnTo: string): string => `${state}.${encodeURIComponent(returnTo)}`;

/** The page to come back to when `presented` matches the cookie's state; undefined otherwise. */
export function checkState(cookieValue: string | undefined, presented: string | null): string | undefined {
  if (!cookieValue || !presented) return undefined;
  const dot = cookieValue.indexOf(".");
  if (dot < 0 || !same(cookieValue.slice(0, dot), presented)) return undefined;
  let returnTo: string;
  try {
    returnTo = decodeURIComponent(cookieValue.slice(dot + 1));
  } catch {
    return "/";
  }
  // Only a path on this server: no `//host` or `/\host`.
  return /^\/(?![/\\])/.test(returnTo) ? returnTo : "/";
}

const sign = (key: string, payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

/** A session for `userId` that ends `SESSION_MAX_AGE_SEC` after `now`. */
export function newSession(key: string, userId: number, now: Date): string {
  const payload = `${SESSION_VERSION}.${userId}.${(now.getTime() + SESSION_MAX_AGE_SEC * 1000).toString(36)}`;
  return `${payload}.${sign(key, payload)}`;
}

/** True for an unexpired session of `ownerId` signed with `key`. */
export function validSession(key: string, value: string | undefined, ownerId: number, now: Date): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const [version, id, expires, mac = ""] = parts;
  const payload = `${version}.${id}.${expires}`;
  if (!same(mac, sign(key, payload))) return false;
  return version === SESSION_VERSION && id === String(ownerId) && Number.parseInt(expires ?? "", 36) > now.getTime();
}

/**
 * The Config form's token (REQ-003-07, REQ-007-05): bound to the session, so another site that can't read the page
 * can't save settings, and a new sign-in gets a new one.
 */
export const formToken = (key: string, session: string): string => sign(key, `form.${session}`);

export type SignInResult =
  | { ok: true; user: { id: number; login: string } }
  | { ok: false; status: 400 | 502; reason: string };

/** Exchanges the callback's code and asks GitHub who signed in; the access token is not kept (REQ-003-08). */
export async function whoSignedIn(login: DashboardLogin, code: string, fetch: Fetch): Promise<SignInResult> {
  try {
    const exchange = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": baseHeaders["user-agent"],
      },
      body: JSON.stringify({ client_id: login.clientId, client_secret: login.clientSecret, code }),
    });
    const t = (await exchange.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!t.access_token)
      return exchange.ok
        ? { ok: false, status: 400, reason: `GitHub refused the code (${t.error ?? "no token"})` }
        : { ok: false, status: 502, reason: `GitHub answered ${exchange.status} to the code exchange` };
    const me = await fetch(`${API}/user`, { headers: { ...baseHeaders, authorization: `Bearer ${t.access_token}` } });
    if (!me.ok) return { ok: false, status: 502, reason: `GitHub answered ${me.status} to GET /user` };
    const user = (await me.json()) as { id: number; login: string };
    return { ok: true, user: { id: user.id, login: user.login } };
  } catch (e) {
    return { ok: false, status: 502, reason: `GitHub out of reach: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Constant-time comparison; hashing first makes the lengths equal. */
export function same(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
