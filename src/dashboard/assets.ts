/**
 * The dashboard's static files (REQ-003-09): a fixed list, served from its own origin. A path not
 * listed here is never read, so a request cannot reach any other file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "assets");

const TYPES = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
} as const;

/** Published path under `/assets/` → content type. */
const LIST = new Map<string, string>([
  ["dashboard.css", TYPES.css],
  ["dashboard.js", TYPES.js],
  ["fonts/plus-jakarta-sans.woff2", TYPES.woff2],
  ["fonts/inter.woff2", TYPES.woff2],
  ["fonts/jetbrains-mono.woff2", TYPES.woff2],
]);

export interface Asset {
  body: Uint8Array;
  type: string;
  /** Short content hash, so a changed file gets a new URL. */
  version: string;
}

const cache = new Map<string, Asset>();

/** The listed file at `name` (relative to `/assets/`), or undefined for anything else. */
export function asset(name: string): Asset | undefined {
  const type = LIST.get(name);
  if (type === undefined) return undefined;
  let a = cache.get(name);
  if (!a) {
    const body = readFileSync(join(DIR, name));
    a = { body, type, version: createHash("sha256").update(body).digest("hex").slice(0, 10) };
    cache.set(name, a);
  }
  return a;
}

/** `/assets/<name>?v=<hash>`, for the page to reference. */
export function assetUrl(name: string): string {
  const a = asset(name);
  if (!a) throw new Error(`not a dashboard asset: ${name}`);
  return `/assets/${name}?v=${a.version}`;
}
