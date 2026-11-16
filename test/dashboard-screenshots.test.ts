import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  committedFingerprint,
  currentInputs,
  type FingerprintInputs,
  fingerprint,
  IMAGES_DIR,
  SHOTS,
} from "../scripts/dashboard-screenshots.ts";
import { mockConfig } from "./fixtures/dashboard-mock.ts";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const dashboardParagraph = readme.match(/^\*\*Dashboard \(read-only.*(?:\n(?!\n).*)*/m)?.[0] ?? "";

const inputs = (): FingerprintInputs => ({
  shots: [{ file: "a.png", page: "/", width: 800, height: 600, scale: 1 }],
  pages: { "/": "<h1>Overview</h1>", "/config": "<h1>Config</h1>" },
  assets: { "dashboard.css": new TextEncoder().encode("body{}"), "dashboard.js": new TextEncoder().encode("1") },
});

describe("README screenshots of the dashboard", () => {
  test("REQ-003-17 render made-up data only, nothing from this repository", () => {
    const { pages } = currentInputs();
    expect(Object.keys(pages).sort()).toEqual(["/", "/config"]);
    for (const html of Object.values(pages)) {
      expect(html).not.toMatch(/Flayms|Github-Issue-Coordinator/i);
      expect(html).toContain("acme/storefront");
    }
    expect(mockConfig.repos.every((r) => r.name.startsWith("acme/"))).toBe(true);
  });

  test("REQ-003-17 the README shows the Overview at desktop and phone width in its Dashboard paragraph", () => {
    expect(dashboardParagraph).not.toBe("");
    const files = SHOTS.map((s) => s.file);
    expect(files).toContain("dashboard-overview.png");
    expect(files).toContain("dashboard-overview-phone.png");
    for (const file of files) expect(dashboardParagraph).toContain(`docs/images/${file}`);
  });

  test("REQ-003-18 the fingerprint is stable for the same inputs", () => {
    expect(fingerprint(inputs())).toBe(fingerprint(inputs()));
    expect(fingerprint(currentInputs())).toBe(fingerprint(currentInputs()));
  });

  test("REQ-003-18 the fingerprint changes with the HTML, an asset or the shot list", () => {
    const base = fingerprint(inputs());
    const html = inputs();
    html.pages["/"] = "<h1>Overview!</h1>";
    const css = inputs();
    css.assets["dashboard.css"] = new TextEncoder().encode("body{color:red}");
    const font = inputs();
    font.assets["fonts/new.woff2"] = new Uint8Array([1, 2, 3]);
    const shot = inputs();
    shot.shots[0] = { file: "a.png", page: "/", width: 390, height: 600, scale: 1 };
    for (const changed of [html, css, font, shot]) expect(fingerprint(changed)).not.toBe(base);
  });

  test("REQ-003-18 the committed screenshots match the dashboard (else run `bun run screenshots`)", () => {
    const stale = "The dashboard changed since the README screenshots were made: run `bun run screenshots`.";
    for (const s of SHOTS) expect(existsSync(join(IMAGES_DIR, s.file)), `${s.file} missing. ${stale}`).toBe(true);
    expect(committedFingerprint(), stale).toBe(fingerprint(currentInputs()));
  });
});
