/**
 * The VM's headless browser, which Implementers may shoot Screenshots with (REQ-001-48). `bun run doctor`
 * reports whether one is installed and starts (REQ-005-05); without one, an Implementer may install its own.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Browser commands looked up on PATH, in this order. */
export const BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] as const;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const START_TIMEOUT_MS = 60_000;

export function findBrowser(which: (bin: string) => string | null = Bun.which): string | undefined {
  return BROWSERS.find((b) => which(b));
}

/** Arguments for one headless screenshot; a throwaway profile keeps the check out of the user's own one. */
export function screenshotArgs(file: string, url: string, userDataDir: string): string[] {
  return [
    "--headless",
    "--disable-gpu",
    `--user-data-dir=${userDataDir}`,
    "--window-size=800,600",
    `--screenshot=${file}`,
    url,
  ];
}

export function isPng(file: string): boolean {
  if (!existsSync(file)) return false;
  const head = readFileSync(file).subarray(0, 4);
  return head.length === 4 && PNG_MAGIC.every((b, i) => head[i] === b);
}

/** Starts `browser` headless on a tiny page and checks it writes a PNG; cleans up after itself. */
export function checkBrowserStarts(browser: string, tmp: string): { ok: boolean; detail: string } {
  const work = mkdtempSync(join(tmp, "doctor-browser-"));
  const file = join(work, "doctor-shot.png");
  try {
    const page = "data:text/html,<h1>Coordinator doctor</h1>";
    const p = Bun.spawnSync([browser, ...screenshotArgs(file, page, join(work, "profile"))], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: START_TIMEOUT_MS,
    });
    const output = `${p.stderr.toString()}\n${p.stdout.toString()}`.trim();
    const error = output.split("\n").slice(-3).join(" | ");
    if (p.exitCode !== 0) return { ok: false, detail: `exit code ${p.exitCode ?? "none (timed out?)"}: ${error}` };
    if (!isPng(file)) return { ok: false, detail: `exited 0 but wrote no PNG: ${error}` };
    return { ok: true, detail: "wrote a PNG headless" };
  } catch (e) {
    return { ok: false, detail: String(e) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
