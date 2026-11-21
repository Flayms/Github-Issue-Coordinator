import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FINGERPRINT_FILE,
  fingerprint,
  mockFingerprint,
  mockPages,
  SCREENSHOTS,
} from "../scripts/dashboard-screenshots.ts";
import { MOCK_CONFIG, MOCK_SNAPSHOT } from "./fixtures/dashboard-mock.ts";

const ROOT = join(import.meta.dir, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("dashboard screenshots", () => {
  test("REQ-003-21 the README shows every screenshot, and each is a committed PNG", () => {
    expect(SCREENSHOTS.map((s) => s.file)).toEqual(
      expect.arrayContaining(["docs/images/dashboard-desktop.png", "docs/images/dashboard-phone.png"]),
    );
    expect(
      SCREENSHOTS.filter((s) => !readme.includes(`src="${s.file}"`) && !readme.includes(`](${s.file})`)).map(
        (s) => s.file,
      ),
    ).toEqual([]);
    for (const s of SCREENSHOTS) {
      const png = readFileSync(join(ROOT, s.file));
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  });

  test("REQ-003-21 every shot is a viewport-sized frame: desktop 1280×800 at 2×, phone 390×844 at 2×", () => {
    const frames = SCREENSHOTS.map((s) => ({
      file: s.file,
      frame: `${s.width}x${s.height}@${s.scale}${s.mobile ? " mobile" : ""}`,
    }));
    for (const { file, frame } of frames)
      expect({ file, frame }).toEqual({ file, frame: file.endsWith("-phone.png") ? "390x844@2 mobile" : "1280x800@2" });
    expect(SCREENSHOTS.filter((s) => "fullPage" in s).map((s) => s.file)).toEqual([]);
    expect(SCREENSHOTS.map((s) => s.file)).toEqual([
      "docs/images/dashboard-desktop.png",
      "docs/images/dashboard-phone.png",
      "docs/images/dashboard-config.png",
      "docs/images/dashboard-timings.png",
    ]);
  });

  test("REQ-003-21 the pages are rendered from made-up data only, not from this repository's issues", () => {
    const repos = [...MOCK_CONFIG.repos.map((r) => r.name), ...MOCK_SNAPSHOT.repos.map((r) => r.repo)];
    for (const r of repos) expect(r.startsWith("acme/")).toBe(true);
    const html = mockPages().join("\n");
    expect(html).toContain("acme/storefront");
    expect(html).not.toMatch(/Flayms/i);
  });

  test("REQ-003-22 the fingerprint is stable for the same input and changes with the HTML or an asset", () => {
    const pages = ["<p>a</p>", "<p>b</p>"];
    const assets = [bytes("body{}"), bytes("font")];
    expect(fingerprint(pages, assets)).toBe(fingerprint([...pages], [...assets]));
    expect(fingerprint(["<p>a!</p>", "<p>b</p>"], assets)).not.toBe(fingerprint(pages, assets));
    expect(fingerprint(pages, [bytes("body{color:red}"), bytes("font")])).not.toBe(fingerprint(pages, assets));
    // Moving content between pages is a change too.
    expect(fingerprint(["<p>a</p><p>b</p>", ""], assets)).not.toBe(fingerprint(pages, assets));
    expect(mockFingerprint()).toBe(mockFingerprint());
  });

  test("REQ-003-22 the committed screenshots were made from the current dashboard (else run `bun run screenshots`)", () => {
    const path = join(ROOT, FINGERPRINT_FILE);
    const committed = existsSync(path) ? readFileSync(path, "utf8").trim() : "(missing)";
    if (committed !== mockFingerprint())
      throw new Error(
        `The dashboard changed since its README screenshots were made: run \`bun run screenshots\` and commit docs/images/ (${FINGERPRINT_FILE} is ${committed}, the dashboard is ${mockFingerprint()}).`,
      );
  });
});
