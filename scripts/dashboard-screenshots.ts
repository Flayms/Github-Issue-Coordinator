/**
 * `bun run screenshots`: renders the dashboard from made-up data (test/fixtures/dashboard-mock.ts) and
 * shoots it with the host's headless Chrome or Chromium into docs/images/ for the README (REQ-003-17).
 * It also records a fingerprint of what it rendered, so `bun test` notices when the dashboard changed
 * but the screenshots weren't regenerated (REQ-003-18). The fingerprint hashes the inputs (the HTML and
 * the asset files), not the PNGs: the animated background makes every image a little different.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { findBrowser, isPng, screenshotEnv } from "../src/browser.ts";
import { asset } from "../src/dashboard/assets.ts";
import { renderConfig } from "../src/dashboard/config-html.ts";
import { renderDashboard } from "../src/dashboard/html.ts";
import { dashboardView } from "../src/dashboard/view.ts";
import { MOCK_NOW, mockConfig, mockSnapshot } from "../test/fixtures/dashboard-mock.ts";

const ROOT = join(import.meta.dir, "..");
export const IMAGES_DIR = join(ROOT, "docs/images");
export const FINGERPRINT_FILE = join(IMAGES_DIR, "dashboard-screenshots.sha256");
const ASSETS_DIR = join(ROOT, "src/dashboard/assets");

/** The pages, rendered from the mock data exactly as the server would serve them. */
const PAGES: Record<string, () => string> = {
  "/": () => renderDashboard(dashboardView(mockSnapshot, mockConfig, MOCK_NOW)),
  "/config": () => renderConfig(dashboardView(mockSnapshot, mockConfig, MOCK_NOW)),
};

export interface Shot {
  /** File name in docs/images/. */
  file: string;
  page: keyof typeof PAGES;
  width: number;
  height: number;
  scale: number;
}

export const SHOTS: Shot[] = [
  { file: "dashboard-overview.png", page: "/", width: 1440, height: 1500, scale: 1 },
  { file: "dashboard-overview-phone.png", page: "/", width: 390, height: 844, scale: 2 },
  { file: "dashboard-config.png", page: "/config", width: 1440, height: 1000, scale: 1 },
];

export interface FingerprintInputs {
  shots: Shot[];
  /** Rendered HTML per page path. */
  pages: Record<string, string>;
  /** Every file under src/dashboard/assets/, by relative path. */
  assets: Record<string, Uint8Array>;
}

/** REQ-003-18: one hash over the shot list, the rendered pages and the asset files. */
export function fingerprint(i: FingerprintInputs): string {
  const h = createHash("sha256");
  const part = (label: string, data: string | Uint8Array) => {
    h.update(`${label}\0${data.length}\0`);
    h.update(data);
  };
  part("shots", JSON.stringify(i.shots));
  for (const path of Object.keys(i.pages).sort()) part(`page ${path}`, i.pages[path] ?? "");
  for (const name of Object.keys(i.assets).sort()) part(`asset ${name}`, i.assets[name] ?? new Uint8Array());
  return h.digest("hex");
}

function assetFiles(dir = ASSETS_DIR): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    out[relative(ASSETS_DIR, path)] = readFileSync(path);
  }
  return out;
}

/** The inputs as they are in the working copy now. */
export function currentInputs(): FingerprintInputs {
  return {
    shots: SHOTS,
    pages: Object.fromEntries(Object.entries(PAGES).map(([path, render]) => [path, render()])),
    assets: assetFiles(),
  };
}

/** The fingerprint the committed screenshots were made from, or undefined if there is none. */
export function committedFingerprint(): string | undefined {
  try {
    return readFileSync(FINGERPRINT_FILE, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Serves the mock pages and the dashboard's assets on a free loopback port. */
function serveMock() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/assets/")) {
        const a = asset(url.pathname.slice("/assets/".length));
        return a ? new Response(a.body, { headers: { "content-type": a.type } }) : new Response("", { status: 404 });
      }
      const page = PAGES[url.pathname];
      return page
        ? new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("", { status: 404 });
    },
  });
}

/**
 * `--disable-gpu` leaves the page without WebGL, so it shows the static gradient instead of a random
 * frame of the animated background (REQ-003-14). The virtual time budget lets the fonts and the script load.
 */
function shoot(browser: string, base: string, shot: Shot, work: string): void {
  const file = join(IMAGES_DIR, shot.file);
  const p = Bun.spawnSync(
    [
      browser,
      "--headless",
      "--no-sandbox",
      "--no-proxy-server",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${join(work, "profile")}`,
      `--window-size=${shot.width},${shot.height}`,
      `--force-device-scale-factor=${shot.scale}`,
      "--virtual-time-budget=3000",
      `--screenshot=${file}`,
      `${base}${shot.page}`,
    ],
    // Config and cache in the temp folder too, as for the doctor (REQ-001-53): the sandbox's home is read-only.
    { env: { ...process.env, ...screenshotEnv(work) }, stdout: "pipe", stderr: "pipe", timeout: 60_000 },
  );
  if (p.exitCode !== 0 || !isPng(file))
    throw new Error(
      `${browser} failed on ${shot.file} (exit ${p.exitCode}): ${p.stderr.toString().trim().slice(-500)}`,
    );
  console.log(`wrote docs/images/${shot.file}`);
}

async function main(): Promise<void> {
  const browser = findBrowser();
  if (!browser) throw new Error("no Chrome or Chromium on PATH (google-chrome, chromium, …); see docs/setup.md");
  mkdirSync(IMAGES_DIR, { recursive: true });
  const server = serveMock();
  const work = mkdtempSync(join(tmpdir(), "dashboard-screenshots-"));
  try {
    for (const shot of SHOTS) shoot(browser, `http://127.0.0.1:${server.port}`, shot, work);
  } finally {
    await server.stop(true);
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(FINGERPRINT_FILE, `${fingerprint(currentInputs())}\n`);
  console.log(`wrote ${relative(ROOT, FINGERPRINT_FILE)}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
