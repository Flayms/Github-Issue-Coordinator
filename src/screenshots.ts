/**
 * Screenshots an Implementer lists in its Result (REQ-001-48): checked before publishing (REQ-001-51)
 * and shown in the PR body (REQ-001-50). Paths come from the agent, so they are untrusted.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Where the Implementer saves Screenshots, relative to the Worktree; its git ignores `.coordinator/`. */
export const SCREENSHOT_DIR = ".coordinator/screenshots";
export const MAX_SCREENSHOTS = 5;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

export interface ListedScreenshot {
  path: string;
  caption: string;
}
/** A Screenshot that passed the checks, under the file name it is published as. */
export interface CheckedScreenshot {
  name: string;
  data: Uint8Array;
  caption: string;
}
export interface SkippedScreenshot {
  path: string;
  reason: string;
}

const inside = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** The image type by its first bytes, or null. */
function imageType(data: Uint8Array): "png" | "jpg" | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => data[i] === b)) return "png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  return null;
}

/** REQ-001-51: reads the listed files that pass the checks; the others are skipped with a reason. */
export function checkScreenshots(
  worktree: string,
  list: ListedScreenshot[],
): { checked: CheckedScreenshot[]; skipped: SkippedScreenshot[] } {
  const checked: CheckedScreenshot[] = [];
  const skipped: SkippedScreenshot[] = [];
  const outside = `outside ${SCREENSHOT_DIR}/`;
  for (const [i, s] of list.entries()) {
    const skip = (reason: string) => skipped.push({ path: s.path, reason });
    if (i >= MAX_SCREENSHOTS) {
      skip(`more than ${MAX_SCREENSHOTS} Screenshots`);
      continue;
    }
    const path = resolve(worktree, s.path);
    if (!inside(resolve(worktree, SCREENSHOT_DIR), path)) {
      skip(outside);
      continue;
    }
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      skip("not found");
      continue;
    }
    // Resolved against the real Worktree, so a symlinked file or folder can't lead out of it.
    if (!inside(join(realpathSync(worktree), SCREENSHOT_DIR), real)) {
      skip(outside);
      continue;
    }
    const stat = statSync(real);
    if (!stat.isFile()) {
      skip("not a regular file");
      continue;
    }
    if (stat.size > MAX_SCREENSHOT_BYTES) {
      skip(`larger than ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MB`);
      continue;
    }
    const data = readFileSync(real);
    const type = imageType(data);
    if (!type) {
      skip("not a PNG or JPEG");
      continue;
    }
    const stem = basename(real, extname(real)).replace(/[^A-Za-z0-9._-]+/g, "-") || "screenshot";
    checked.push({ name: `${checked.length + 1}-${stem}.${type}`, data, caption: s.caption });
  }
  return { checked, skipped };
}

/** Where a published Screenshot lives on the `agent-screenshots` branch (REQ-001-49). */
export const screenshotPath = (pr: number, head: string, name: string) => `pr-${pr}/${head}/${name}`;

/** Through github.com, so a private repository's images render for viewers with access. */
const screenshotUrl = (repo: string, commit: string, path: string) =>
  `https://github.com/${repo}/raw/${commit}/${path}`;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * REQ-001-50: the `## Screenshots` section of the PR body. `published` is the commit the checked files
 * were published in; `error` says why publishing failed.
 */
export function renderScreenshots(o: {
  repo: string;
  pr: number;
  head: string;
  checked: CheckedScreenshot[];
  skipped: SkippedScreenshot[];
  published?: string;
  error?: string;
}): string {
  const parts = ["## Screenshots"];
  if (o.published) {
    for (const s of o.checked) {
      const caption = oneLine(s.caption);
      const alt = oneLine(caption.replace(/[[\]()]/g, " "));
      parts.push(
        `**${caption}**`,
        `![${alt}](${screenshotUrl(o.repo, o.published, screenshotPath(o.pr, o.head, s.name))})`,
      );
    }
  }
  if (o.error) parts.push(`The Screenshots could not be published: ${oneLine(o.error).slice(0, 500)}`);
  if (o.skipped.length)
    parts.push(
      ["Skipped:", ...o.skipped.map((s) => `- \`${oneLine(s.path).replace(/`/g, "'")}\`: ${s.reason}`)].join("\n"),
    );
  return parts.join("\n\n");
}
