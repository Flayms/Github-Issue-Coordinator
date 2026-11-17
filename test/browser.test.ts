import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBrowserStarts, findBrowser, screenshotArgs } from "../src/browser.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browser-"));
});
afterEach(() => rmSync(dir, { recursive: true }));

/** A fake browser: a shell script that gets the real arguments. */
function fakeBrowser(body: string) {
  const path = join(dir, "fake-chrome");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
// The fake writes a PNG to the path given by --screenshot=<file>.
const WRITES_PNG = `for a in "$@"; do case "$a" in --screenshot=*) printf '\\211PNG\\r\\n\\032\\n' > "\${a#--screenshot=}";; esac; done`;

describe("headless browser check (doctor)", () => {
  test("REQ-005-05 the doctor finds the first browser on PATH", () => {
    const which = (b: string) => (b === "chromium" ? "/usr/bin/chromium" : null);
    expect(findBrowser(which)).toBe("chromium");
    expect(findBrowser(() => null)).toBeUndefined();
  });

  test("REQ-005-05 shoots headless with a throwaway profile, without sandbox workarounds", () => {
    const args = screenshotArgs("/w/shot.png", "http://127.0.0.1:1/", "/t/profile");
    expect(args).toEqual(
      expect.arrayContaining(["--headless", "--user-data-dir=/t/profile", "--screenshot=/w/shot.png"]),
    );
    expect(args).not.toContain("--no-sandbox");
    expect(args).not.toContain("--no-proxy-server");
    expect(args.at(-1)).toBe("http://127.0.0.1:1/");
  });

  test("REQ-005-05 a browser that writes a non-empty PNG starts", () => {
    const r = checkBrowserStarts(fakeBrowser(`${WRITES_PNG}\nexit 0`), dir);
    expect(r).toEqual({ ok: true, detail: expect.stringContaining("PNG") });
  });

  test("REQ-005-05 a browser that exits non-zero fails with its error", () => {
    const r = checkBrowserStarts(fakeBrowser("echo 'Missing X server' >&2\nexit 1"), dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("exit code 1");
    expect(r.detail).toContain("Missing X server");
  });

  test("REQ-005-05 a browser that exits 0 without writing a PNG fails", () => {
    const r = checkBrowserStarts(fakeBrowser("echo started\nexit 0"), dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no PNG");
  });

  test("REQ-005-05 the check leaves nothing behind", () => {
    checkBrowserStarts(fakeBrowser(`${WRITES_PNG}\nexit 0`), dir);
    expect(readdirSync(dir)).toEqual(["fake-chrome"]);
  });
});
