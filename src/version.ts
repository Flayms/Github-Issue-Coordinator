/** The package's version (REQ-007-12) and the files it ships next to the source (REQ-007-15). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME } from "./paths.ts";

/** The package's root folder: the checkout, or the global install's `node_modules/issueflow`. */
export const PACKAGE_ROOT = join(import.meta.dir, "..");
/** REQ-007-04: the JSON Schema of the config file. */
export const CONFIG_SCHEMA_PATH = join(PACKAGE_ROOT, "config.schema.json");

export const VERSION: string = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;

/** Whether `latest` is a newer semver than `current`; false for anything that isn't a version. */
export function newerVersion(current: string, latest: string): boolean {
  try {
    return Bun.semver.order(latest, current) === 1;
  } catch {
    return false;
  }
}

/** REQ-007-12: the newest version on npm; throws when the registry can't be reached or answers oddly. */
export async function latestOnNpm(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`https://registry.npmjs.org/${APP_NAME}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`npm says ${res.status}`);
  const { version } = (await res.json()) as { version?: unknown };
  if (typeof version !== "string") throw new Error("npm sent no version");
  return version;
}

/** REQ-007-12: the doctor's line about the version; npm out of reach is a warning. */
export async function versionCheck(
  current: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: "ok" | "warn"; check: string; detail: string }> {
  try {
    const latest = await latestOnNpm(fetchFn);
    return newerVersion(current, latest)
      ? {
          status: "warn",
          check: "version",
          detail: `${current}; ${latest} is on npm: bun add -g ${APP_NAME}@latest && issueflow service restart`,
        }
      : {
          status: "ok",
          check: "version",
          detail: `${current} (${latest === current ? "the latest on npm" : `npm has ${latest}`})`,
        };
  } catch (e) {
    return {
      status: "warn",
      check: "version",
      detail: `${current}; could not ask npm for a newer one (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}
