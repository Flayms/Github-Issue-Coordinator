/**
 * `bun run screenshots`: renders the README screenshots of the dashboard from made-up data
 * (REQ-003-21) and records the fingerprint of what they were made from, which `bun test` compares
 * with the current dashboard (REQ-003-22). Needs Chrome or Chromium (`$CHROME` to pick one); the
 * tests need no browser.
 *
 * Exactly the fingerprinted pages are served, with the dashboard's assets, and shot through the
 * Chrome DevTools Protocol, so a shot can show the whole page.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ASSET_NAMES, asset } from "../src/dashboard/assets.ts";
import { renderConfig } from "../src/dashboard/config-html.tsx";
import { renderDashboard } from "../src/dashboard/html.tsx";
import { timingsView } from "../src/dashboard/timings.ts";
import { renderTimings } from "../src/dashboard/timings-html.tsx";
import { dashboardView } from "../src/dashboard/view.ts";
import { MOCK_CONFIG, MOCK_NOW, MOCK_SNAPSHOT, MOCK_TIMING_SOURCE } from "../test/fixtures/dashboard-mock.ts";

const ROOT = join(import.meta.dir, "..");

/** Where the fingerprint of the committed screenshots lives, relative to the repository. */
export const FINGERPRINT_FILE = "docs/images/dashboard-screenshots.sha256";

export interface Screenshot {
  /** Relative to the repository; the README links it. */
  file: string;
  /** Dashboard path. */
  page: "/" | "/config" | "/timings";
  width: number;
  /** The viewport height; with `fullPage`, the shot grows to the height of the page. */
  height: number;
  scale: number;
  mobile: boolean;
  fullPage: boolean;
}

export const SCREENSHOTS: readonly Screenshot[] = [
  {
    file: "docs/images/dashboard-desktop.png",
    page: "/",
    width: 1280,
    height: 900,
    scale: 1,
    mobile: false,
    fullPage: true,
  },
  {
    file: "docs/images/dashboard-phone.png",
    page: "/",
    width: 390,
    height: 844,
    scale: 2,
    mobile: true,
    fullPage: false,
  },
  {
    file: "docs/images/dashboard-config.png",
    page: "/config",
    width: 1280,
    height: 900,
    scale: 1,
    mobile: false,
    fullPage: true,
  },
  {
    file: "docs/images/dashboard-timings.png",
    page: "/timings",
    width: 1280,
    height: 720,
    scale: 1,
    mobile: false,
    fullPage: true,
  },
];

/** The Overview, the Config page and the Timings page as the server renders them from the mock data. */
export function mockPages(): string[] {
  const view = dashboardView(MOCK_SNAPSHOT, MOCK_CONFIG, MOCK_NOW);
  const timings = timingsView({ source: MOCK_TIMING_SOURCE, pick: null, includeOwner: false, now: MOCK_NOW });
  return [renderDashboard(view), renderConfig(view), renderTimings(view, timings)];
}

/** A hash of the pages and the assets, each length-prefixed so moving bytes between them changes it. */
export function fingerprint(pages: readonly string[], assets: readonly Uint8Array[]): string {
  const h = createHash("sha256");
  for (const [kind, items] of [
    ["page", pages.map((p) => new TextEncoder().encode(p))],
    ["asset", assets],
  ] as const)
    for (const b of items) h.update(`${kind}:${b.length}:`).update(b);
  return h.digest("hex");
}

/** The fingerprint of the current dashboard: the mock pages plus every asset (CSS, script, fonts). */
export function mockFingerprint(): string {
  return fingerprint(
    mockPages(),
    ASSET_NAMES.map((n) => {
      const a = asset(n);
      if (!a) throw new Error(`not a dashboard asset: ${n}`);
      return a.body;
    }),
  );
}

// --- Capture ------------------------------------------------------------------------------------

function findBrowser(): string {
  const names = [process.env.CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const n of names) {
    const path = n && Bun.which(n);
    if (path) return path;
  }
  throw new Error("no Chrome or Chromium found; install one or set $CHROME");
}

/** A minimal Chrome DevTools Protocol client over one page target. */
class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, (() => void)[]>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners.get(msg.method)?.splice(0) ?? []) l();
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  once(event: string): Promise<void> {
    return new Promise((resolve) => this.listeners.set(event, [...(this.listeners.get(event) ?? []), resolve]));
  }

  close() {
    this.ws.close();
  }
}

async function waitFor<T>(what: string, f: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

async function shoot(cdp: Cdp, base: string, s: Screenshot): Promise<Uint8Array> {
  const metrics = (height: number) =>
    cdp.send("Emulation.setDeviceMetricsOverride", {
      width: s.width,
      height,
      deviceScaleFactor: s.scale,
      mobile: s.mobile,
    });
  await metrics(s.height);
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: base + s.page });
  await loaded;
  await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
  if (s.fullPage) {
    // Grow the viewport to the page, so the fixed background covers all of it.
    const { cssContentSize } = await cdp.send<{ cssContentSize: { height: number } }>("Page.getLayoutMetrics");
    await metrics(Math.ceil(cssContentSize.height));
  }
  // Let the background draw a few frames at the final size.
  await Bun.sleep(1500);
  const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  return Buffer.from(data, "base64");
}

async function main() {
  const [overview = "", config = "", timings = ""] = mockPages();
  const pages = new Map([
    ["/", overview],
    ["/config", config],
    ["/timings", timings],
  ]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const page = pages.get(path);
      if (page !== undefined) return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      const a = path.startsWith("/assets/") ? asset(path.slice("/assets/".length)) : undefined;
      return a
        ? new Response(a.body, { headers: { "content-type": a.type } })
        : new Response("Not found", { status: 404 });
    },
  });
  const profile = mkdtempSync(join(tmpdir(), "dashboard-screenshots-"));
  const browser = Bun.spawn(
    [
      findBrowser(),
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--hide-scrollbars",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    const port = await waitFor("the browser's DevTools port", () => {
      try {
        return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] || undefined;
      } catch {
        return undefined;
      }
    });
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("the browser has no page");
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    const base = `http://127.0.0.1:${server.port}`;
    for (const s of SCREENSHOTS) {
      const png = await shoot(cdp, base, s);
      mkdirSync(dirname(join(ROOT, s.file)), { recursive: true });
      writeFileSync(join(ROOT, s.file), png);
      console.log(`${s.file} (${Math.round(png.length / 1024)} KB)`);
    }
    cdp.close();
    writeFileSync(join(ROOT, FINGERPRINT_FILE), `${mockFingerprint()}\n`);
    console.log(`${FINGERPRINT_FILE} updated`);
  } finally {
    browser.kill();
    await browser.exited;
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
