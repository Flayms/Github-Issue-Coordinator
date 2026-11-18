/**
 * REQ-005-08: free space where agent sessions write temp files: their session folders (REQ-001-62) and `/tmp`,
 * which on many hosts is a small tmpfs. A full one makes sessions fail with ENOSPC.
 */
import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";

export const LOW_TEMP_SPACE_BYTES = 1024 ** 3;

export interface Check {
  status: "ok" | "warn";
  check: string;
  detail: string;
}

/** Bytes free for an unprivileged writer on the volume holding `path` (or its nearest existing parent). */
export function freeBytes(path: string): number {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const s = statfsSync(p);
  return s.bavail * s.bsize;
}

const size = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/** One check per volume; low space is a warning, never an error. */
export function tempSpaceChecks(
  paths: { sessions: string; tmp: string },
  free: (path: string) => number = freeBytes,
  threshold = LOW_TEMP_SPACE_BYTES,
): Check[] {
  const volumes: [check: string, path: string][] = [
    ["free space for session folders", paths.sessions],
    [`free space in ${paths.tmp}`, paths.tmp],
  ];
  return volumes.map(([check, path]): Check => {
    let bytes: number;
    try {
      bytes = free(path);
    } catch (e) {
      return { status: "warn", check, detail: `${path}: could not read (${e instanceof Error ? e.message : e})` };
    }
    return bytes < threshold
      ? {
          status: "warn",
          check,
          detail: `${path}: only ${size(bytes)} free (below ${size(threshold)}); agent sessions may fail with ENOSPC`,
        }
      : { status: "ok", check, detail: `${path}: ${size(bytes)} free` };
  });
}
