/** `coordinator init` on this machine (REQ-007-08): the terminal questions, `gh`, the files, the doctor and systemd. */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultStateDir } from "../paths.ts";
import { CONFIG_SCHEMA_PATH } from "../version.ts";
import { clackPrompter } from "./clack.ts";
import { type InitEnv, init } from "./wizard.ts";

const gh = (args: string[], stdin?: string) => {
  const r = Bun.spawnSync(["gh", ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

const ghJson = <T>(args: string[]): T => {
  const r = gh(["api", ...args]);
  if (!r.ok) throw new Error(`gh api ${args.join(" ")}: ${r.err || r.out}`);
  return JSON.parse(r.out) as T;
};

export const machineInitEnv = (): InitEnv => ({
  ghLoggedIn: () => gh(["auth", "status"]).ok,
  ghLogin: (token) => {
    const r = gh(["auth", "login", "--with-token"], token);
    return { ok: r.ok, out: r.err || r.out };
  },
  ghUser: async (login) => {
    const u = ghJson<{ login: string; id: number }>([login ? `users/${login}` : "user"]);
    return { login: u.login, id: u.id };
  },
  ghRepos: async () => {
    // `--slurp` makes the pages one JSON array of pages.
    const pages = ghJson<{ full_name: string; permissions?: { push?: boolean } }[][]>([
      "--paginate",
      "--slurp",
      "user/repos?per_page=100&sort=full_name",
    ]);
    return pages.flat().flatMap((r) => (r.permissions?.push ? [r.full_name] : []));
  },
  rootFiles: async (repo) => {
    try {
      return ghJson<{ name: string }[]>([`repos/${repo}/contents/`]).map((f) => f.name);
    } catch {
      return [];
    }
  },
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writeFile: (path, text, mode) => {
    mkdirSync(dirname(path), { recursive: true, ...(mode ? { mode: 0o700 } : {}) });
    // In one step, and a secret is never readable by others, not even for a moment.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: mode ?? 0o644 });
    if (mode) chmodSync(tmp, mode);
    renameSync(tmp, path);
  },
  randomToken: () => randomBytes(32).toString("base64url"),
  doctor: async (path) => (await import("../doctor.ts")).doctor(path),
  serviceInstall: async (path) => (await import("../service.ts")).service("install", path),
  schemaUrl: pathToFileURL(CONFIG_SCHEMA_PATH).href,
  home: homedir(),
  defaultStateDir: defaultStateDir(),
});

export const runInit = (configPath: string): Promise<number> => init(configPath, clackPrompter(), machineInitEnv());
