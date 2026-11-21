/** `issueflow init` on this machine (REQ-007-08): the terminal questions, `gh`, the files, the doctor and systemd. */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultStateDir } from "../paths.ts";
import { CONFIG_SCHEMA_PATH } from "../version.ts";
import { clackPrompter } from "./clack.ts";
import { type InitEnv, init } from "./wizard.ts";

/** Runs `gh` with these arguments; tests pass `machineInitEnv` another one. */
export type GhRunner = (args: string[], stdin?: string) => { ok: boolean; out: string; err: string };

const runGh: GhRunner = (args, stdin) => {
  const r = Bun.spawnSync(["gh", ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

const ghApi = (gh: GhRunner, args: string[]): string => {
  const r = gh(["api", ...args]);
  if (!r.ok) throw new Error(`gh api ${args.join(" ")}: ${r.err || r.out}`);
  return r.out;
};

const ghJson = <T>(gh: GhRunner, args: string[]): T => JSON.parse(ghApi(gh, args)) as T;

export const machineInitEnv = (gh: GhRunner = runGh): InitEnv => ({
  ghLoggedIn: () => gh(["auth", "status"]).ok,
  ghLogin: (token) => {
    const r = gh(["auth", "login", "--with-token"], token);
    return { ok: r.ok, out: r.err || r.out };
  },
  ghUser: async (login) => {
    const u = ghJson<{ login: string; id: number }>(gh, [login ? `users/${login}` : "user"]);
    return { login: u.login, id: u.id };
  },
  ghRepos: async () => {
    // `--jq` prints one line per repository, across all pages, on gh 2.46 too (Ubuntu's apt gh, #202).
    const out = ghApi(gh, [
      "--paginate",
      "user/repos?per_page=100&sort=full_name",
      "--jq",
      ".[] | select(.permissions.push) | .full_name",
    ]);
    return out.split("\n").filter((line) => line !== "");
  },
  rootFiles: async (repo) => {
    try {
      return ghJson<{ name: string }[]>(gh, [`repos/${repo}/contents/`]).map((f) => f.name);
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
  onPath: (bin) => Bun.which(bin) !== null,
  doctor: async (path) => (await import("../doctor.ts")).doctor(path),
  serviceInstall: async (path) => (await import("../service.ts")).service("install", path),
  schemaUrl: pathToFileURL(CONFIG_SCHEMA_PATH).href,
  home: homedir(),
  defaultStateDir: defaultStateDir(),
});

export const runInit = (configPath: string): Promise<number> => init(configPath, clackPrompter(), machineInitEnv());
