/**
 * Read-only dashboard server (spec 003), inside the Coordinator process. It serves only the last
 * tick's snapshot: no GitHub calls, no store writes (REQ-003-07, REQ-003-08).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { TickSnapshot } from "../coordinator.ts";
import { renderDashboard } from "./html.ts";
import { dashboardView } from "./view.ts";

const COOKIE = "coordinator_dashboard";
const COOKIE_MAX_AGE_SEC = 365 * 24 * 3600;

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export interface DashboardDeps {
  config: Config;
  /** The configured token (REQ-003-07); without one, no request needs one. */
  token?: string;
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
    return server;
  } catch (e) {
    d.log(`dashboard not started: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function respond(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS, ...headers },
  });
}

function handle(req: Request, d: DashboardDeps): Response {
  try {
    const url = new URL(req.url);
    const viaQuery = url.searchParams.get("token");
    if (d.token) {
      if (viaQuery !== null) {
        if (!same(viaQuery, d.token)) return unauthorized();
        // Keep the token in a cookie and drop it from the address bar.
        return respond(303, "", {
          location: "/",
          "set-cookie": `${COOKIE}=${d.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}`,
        });
      }
      const presented = bearer(req) ?? cookie(req, COOKIE);
      if (presented === undefined || !same(presented, d.token)) return unauthorized();
    }
    if (req.method !== "GET") return respond(405, "Method not allowed", { allow: "GET" });
    if (url.pathname !== "/") return respond(404, "Not found");
    const view = dashboardView(d.snapshot(), d.config, d.now?.() ?? new Date());
    return respond(200, renderDashboard(view), { "content-type": "text/html; charset=utf-8" });
  } catch (e) {
    d.log(`dashboard: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return respond(500, "Internal error");
  }
}

const unauthorized = () => respond(401, "Unauthorized: open the dashboard once with ?token=<your token>.");

/** Constant-time comparison; hashing first makes the lengths equal. */
function same(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

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
