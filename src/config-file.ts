/**
 * The config file while the Coordinator runs (REQ-007-05 to REQ-007-07): the Config page saves into it, a hand edit is
 * picked up before the next tick, and the settings that need a restart keep their startup values until then. Only an
 * allow-list of keys can be changed from the dashboard; repositories, Accounts, access settings and `setup` commands
 * are changed in the file.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AUTO_MERGE_MODES, type Config, ConfigError, EFFORTS, LIMIT_KEYS, parseConfig } from "./config.ts";

/** A model name, never an option for the `claude` command line (e.g. `opus`, `claude-opus-5-5`, `opus[1m]`). */
const model = z.string().regex(/^[A-Za-z0-9][\w.:[\]-]*$/, "must be a model name");
/** `null` removes the key: no effort (the model's default) globally, the global one in a repository. */
const effort = z.enum(EFFORTS).nullable();
const autoMerge = z.enum(AUTO_MERGE_MODES);
const perRole = <T extends z.ZodType>(r: T) =>
  z.strictObject({ planner: r.optional(), implementer: r.optional(), reviewer: r.optional() });
/** REQ-003-44: `null` removes a Role's text; the size limit is checked with the whole config. */
const instructions = perRole(z.string().nullable());

/** What the Config page may change (REQ-007-05); `null` removes a key from the file. */
const settingsChangeSchema = z.strictObject({
  pollIntervalSec: z.number().optional(),
  checksGraceSeconds: z.number().optional(),
  limits: z.strictObject(Object.fromEntries(LIMIT_KEYS.map((k) => [k, z.number().optional()]))).optional(),
  roles: perRole(z.strictObject({ model: model.optional(), effort: effort.optional() })).optional(),
  autoMerge: autoMerge.optional(),
  instructions: instructions.optional(),
  /** By repository name; a `null` model or `autoMerge` removes the repository's own, so the global one applies. */
  repos: z
    .record(
      z.string(),
      z.strictObject({
        roles: perRole(z.strictObject({ model: model.nullable().optional(), effort: effort.optional() })).optional(),
        autoMerge: autoMerge.nullable().optional(),
        instructions: instructions.optional(),
      }),
    )
    .optional(),
});

export type SettingsChange = z.infer<typeof settingsChangeSchema>;

/** The settings the Config page edits. */
export interface SettingsEditor {
  /** The config in use. */
  readonly current: Config;
  /** REQ-007-07: the restart-only settings that differ in the file from those in use. */
  readonly restartPending: readonly string[];
  /** Validates, writes the file and applies at once; throws a `ConfigError` and changes nothing when invalid. */
  save(change: SettingsChange): void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** `change` laid over `target`: keys keep their place, `null` removes one, a block left empty goes away. */
function patch(target: unknown, change: object): Json {
  const out: Json = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(change)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else if (isObject(v)) {
      const merged = patch(out[k], v);
      if (Object.keys(merged).length) out[k] = merged;
      else delete out[k];
    } else out[k] = v;
  }
  return out;
}

const sameName = (a: unknown, b: string) => isObject(a) && String(a.name).toLowerCase() === b.toLowerCase();

/** The file's JSON with a Config page change applied; a change for a repository not in the file is ignored. */
export function applySettings(raw: unknown, change: SettingsChange): Json {
  const { repos, ...rest } = change;
  const out = patch(raw, rest);
  if (repos && Array.isArray(out.repos))
    out.repos = out.repos.map((r) => {
      const p = Object.entries(repos).find(([name]) => sameName(r, name))?.[1];
      return p ? patch(r, p) : r;
    });
  return out;
}

/** REQ-007-07: top-level keys that apply only from a restart, in the order the Config page names them. */
const RESTART_ONLY = ["owner", "github", "stateDir", "accounts", "dashboard"] as const;
/** The keys of a repository the Config page edits; its `name` and `setup` need a restart. */
const EDITABLE_REPO_KEYS = ["roles", "autoMerge", "instructions"];

const repoList = (raw: Json): unknown[] => (Array.isArray(raw.repos) ? raw.repos : []);
const withoutEditable = (repo: unknown) =>
  isObject(repo) ? Object.fromEntries(Object.entries(repo).filter(([k]) => !EDITABLE_REPO_KEYS.includes(k))) : repo;

/** The file's JSON with the restart-only parts as the Coordinator started with them. */
function withStartupParts(disk: Json, startup: Json): Json {
  const out: Json = { ...disk };
  for (const k of RESTART_ONLY) {
    if (k in startup) out[k] = startup[k];
    else delete out[k];
  }
  out.repos = repoList(startup).map((r) => {
    const d = isObject(r) ? repoList(disk).find((x) => sameName(x, String(r.name))) : undefined;
    if (!isObject(r) || !isObject(d)) return r;
    const repo: Json = { ...r };
    for (const k of EDITABLE_REPO_KEYS) {
      if (k in d) repo[k] = d[k];
      else delete repo[k];
    }
    return repo;
  });
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function restartPendingOf(disk: Json, startup: Json): string[] {
  const keys: string[] = RESTART_ONLY.filter((k) => !same(disk[k], startup[k]));
  if (!same(repoList(disk).map(withoutEditable), repoList(startup).map(withoutEditable))) keys.push("repos");
  return keys;
}

/** Writes the config's JSON readably (two-space indent) in one step: a temp file, then a rename (REQ-007-05). */
export function writeConfigFile(path: string, raw: object): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  renameSync(tmp, path);
}

const parseJson = (text: string, source: string): Json => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`(root): not JSON (${e instanceof Error ? e.message : String(e)})`], source);
  }
  if (!isObject(raw)) throw new ConfigError(["(root): must be an object"], source);
  return raw;
};

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** The live config (REQ-007-05): readers ask for `current` each time, so a change applies from the next tick on. */
export class ConfigFile implements SettingsEditor {
  /** The config as the Coordinator started with it: the restart-only settings are read from here. */
  readonly startup: Config;
  private readonly startupRaw: Json;
  private readonly log: (message: string) => void;
  private cfg: Config;
  private pending: string[] = [];
  /** The file's text last read, valid or not, so a change is noticed and an invalid one logged once. */
  private text: string;

  /** Throws when the file is missing or invalid, so the start stops with the reason. */
  constructor(
    readonly path: string,
    opts: { log?: (message: string) => void } = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.text = readFileSync(path, "utf8");
    this.startupRaw = parseJson(this.text, path);
    this.startup = this.parse(this.startupRaw);
    this.cfg = this.startup;
  }

  get current(): Config {
    return this.cfg;
  }

  get restartPending(): readonly string[] {
    return this.pending;
  }

  /**
   * REQ-007-06: reads the file again when it changed since the last read; true when new settings apply. An invalid
   * file is logged and the last valid config stays.
   */
  reload(): boolean {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      text = `(unreadable: ${e instanceof Error ? e.message : String(e)})`;
    }
    if (text === this.text) return false;
    this.text = text;
    try {
      this.apply(parseJson(text, this.path));
    } catch (e) {
      this.log(
        `config: ${this.path} is invalid, keeping the last valid config: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
    this.log(`config: ${this.path} changed, the new settings apply from this tick on`);
    return true;
  }

  save(change: SettingsChange): void {
    const r = settingsChangeSchema.safeParse(change);
    if (!r.success) throw new ConfigError(issues(r.error), "settings");
    // REQ-007-06: from the file as it is now, so a hand edit is kept; an invalid file is never overwritten.
    const text = readFileSync(this.path, "utf8");
    const next = applySettings(parseJson(text, this.path), r.data);
    const cfg = this.check(next);
    writeConfigFile(this.path, next);
    this.text = readFileSync(this.path, "utf8");
    this.cfg = cfg;
    this.pending = restartPendingOf(next, this.startupRaw);
  }

  private parse(raw: unknown): Config {
    return parseConfig(raw, { source: this.path, configPath: this.path });
  }

  /** The config `disk` gives with the startup's restart-only parts; throws when `disk` itself isn't valid. */
  private check(disk: Json): Config {
    this.parse(disk);
    return this.parse(withStartupParts(disk, this.startupRaw));
  }

  private apply(disk: Json): void {
    this.cfg = this.check(disk);
    this.pending = restartPendingOf(disk, this.startupRaw);
  }
}
