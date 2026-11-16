import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBrowserStarts, findBrowser, screenshotArgs, screenshotEnv } from "../src/browser.ts";

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
  test("REQ-001-53 the doctor finds the first browser on PATH", () => {
    const which = (b: string) => (b === "chromium" ? "/usr/bin/chromium" : null);
    expect(findBrowser(which)).toBe("chromium");
    expect(findBrowser(() => null)).toBeUndefined();
  });

  test("REQ-001-53 shoots headless with --no-sandbox, a throwaway profile and no proxy", () => {
    const args = screenshotArgs("/w/shot.png", "http://127.0.0.1:1/", "/t/profile");
    expect(args).toEqual(
      expect.arrayContaining([
        "--headless",
        "--no-sandbox",
        "--no-proxy-server",
        "--user-data-dir=/t/profile",
        "--screenshot=/w/shot.png",
      ]),
    );
    expect(args.at(-1)).toBe("http://127.0.0.1:1/");
  });

  test("REQ-001-53 a browser that writes a non-empty PNG starts", () => {
    const r = checkBrowserStarts(fakeBrowser(`${WRITES_PNG}\nexit 0`), dir);
    expect(r).toEqual({ ok: true, detail: expect.stringContaining("PNG") });
  });

  test("REQ-001-53 a browser that exits non-zero fails with its error", () => {
    const r = checkBrowserStarts(fakeBrowser("echo 'No usable sandbox!' >&2\nexit 1"), dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("exit code 1");
    expect(r.detail).toContain("No usable sandbox!");
  });

  test("REQ-001-53 a browser that exits 0 without writing a PNG fails", () => {
    const r = checkBrowserStarts(fakeBrowser("echo started\nexit 0"), dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no PNG");
  });

  test("REQ-001-53 keeps the browser's config and cache folders in a temporary folder", () => {
    expect(screenshotEnv("/t")).toEqual({ XDG_CONFIG_HOME: "/t/config", XDG_CACHE_HOME: "/t/cache" });
  });

  test("REQ-001-53 starts the browser with an unwritable home, as in the Implementer's sandbox", () => {
    // Chrome's crash handler core-dumps when it can't write ~/.config; the sandbox's home folder is read-only.
    const needsWritableXdg = [
      'case "$HOME" in /nonexistent*) ;; *) echo "home is writable: $HOME" >&2; exit 2;; esac',
      'mkdir -p "$XDG_CONFIG_HOME/c" "$XDG_CACHE_HOME/c" || { echo "Trace/breakpoint trap" >&2; exit 133; }',
      WRITES_PNG,
      "exit 0",
    ].join("\n");
    expect(checkBrowserStarts(fakeBrowser(needsWritableXdg), dir)).toEqual({ ok: true, detail: expect.any(String) });
  });

  test("REQ-001-53 the check leaves nothing behind", () => {
    checkBrowserStarts(fakeBrowser(`${WRITES_PNG}\nexit 0`), dir);
    expect(readdirSync(dir)).toEqual(["fake-chrome"]);
  });
});
