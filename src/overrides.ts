/**
 * Settings overrides (REQ-003-36): what the Owner changes on the Config page, kept in
 * `<stateDir>/config.overrides.json` and laid over `config.ts`, with the Extra instructions (REQ-003-44). Only an allow-list of keys can be set;
 * repositories, Accounts, access settings and `setup` commands stay in `config.ts`.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  AUTO_MERGE_MODES,
  type Config,
  ConfigError,
  type ConfigInput,
  EFFORTS,
  importConfig,
  LIMIT_KEYS,
  parseConfig,
  ROLES,
  type Role,
} from "./config.ts";

export const OVERRIDES_FILE = "config.overrides.json";

/** A model name, never an option for the `claude` command line (e.g. `opus`, `claude-opus-5-5`, `opus[1m]`). */
const model = z.string().regex(/^[A-Za-z0-9][\w.:[\]-]*$/, "must be a model name");
/** `null` removes `config.ts`'s value: no effort (Claude's default) globally, the global one in a repository. */
const effort = z.enum(EFFORTS).nullable();
const autoMerge = z.enum(AUTO_MERGE_MODES);
const perRole = <T extends z.ZodType>(r: T) =>
  z.strictObject({ planner: r.optional(), implementer: r.optional(), reviewer: r.optional() });
/** REQ-003-44: an empty text replaces `config.ts`'s; the size limit is checked with the merged config. */
const instructions = perRole(z.string());

const overridesSchema = z.strictObject({
  pollIntervalSec: z.number().optional(),
  checksGraceSeconds: z.number().optional(),
  limits: z.strictObject(Object.fromEntries(LIMIT_KEYS.map((k) => [k, z.number().optional()]))).optional(),
  roles: perRole(z.strictObject({ model: model.optional(), effort: effort.optional() })).optional(),
  /** REQ-001-65; the old name `risk-evaluated` is only read from `config.ts`. */
  autoMerge: autoMerge.optional(),
  instructions: instructions.optional(),
  /**
   * By repository name; a `null` model or `autoMerge` removes `config.ts`'s override, so the global one applies.
   */
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

export type Overrides = z.infer<typeof overridesSchema>;

/** The editable settings: `config.ts` underneath, the overrides on top, and saving new overrides. */
export interface SettingsEditor {
  /** `config.ts` alone. */
  readonly base: Config;
  /** `config.ts` with the overrides. */
  readonly current: Config;
  readonly overrides: Overrides;
  /** Validates, writes the file and applies at once; throws a `ConfigError` and changes nothing when invalid. */
  save(overrides: Overrides): void;
}

const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

function parseOverrides(raw: unknown, source: string): Overrides {
  const r = overridesSchema.safeParse(raw);
  if (!r.success) throw new ConfigError(issues(r.error), source);
  return r.data;
}

function readOverrides(path: string): Overrides {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`(root): not JSON (${e instanceof Error ? e.message : String(e)})`], path);
  }
  return parseOverrides(raw, path);
}

/** `patch` over `base`: a `null` removes the key. */
function merge<T extends object>(base: T | undefined, patch: object | undefined): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

type RoleOverrides = Partial<Record<Role, object>>;

/** Merges each Role present in either; a Role left empty is dropped. */
function mergeRoles<T extends object>(base: Partial<Record<Role, T>> | undefined, patch: RoleOverrides | undefined) {
  const out: Partial<Record<Role, T>> = {};
  for (const role of ROLES) {
    if (!base?.[role] && !patch?.[role]) continue;
    const merged = merge(base?.[role], patch?.[role]);
    if (Object.keys(merged).length || base?.[role]) out[role] = merged;
  }
  return out;
}

/** `config.ts`'s input with the overrides laid over it; the input itself is left as it is. */
export function applyOverrides(raw: ConfigInput, o: Overrides): ConfigInput {
  const repoPatch = (name: string) =>
    Object.entries(o.repos ?? {}).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
  return {
    ...raw,
    ...(o.pollIntervalSec !== undefined && { pollIntervalSec: o.pollIntervalSec }),
    ...(o.checksGraceSeconds !== undefined && { checksGraceSeconds: o.checksGraceSeconds }),
    ...(o.autoMerge !== undefined && { autoMerge: o.autoMerge }),
    ...(o.limits && { limits: merge(raw.limits, o.limits) }),
    ...(o.roles && raw.roles && { roles: { ...raw.roles, ...mergeRoles(raw.roles, o.roles) } }),
    ...(o.instructions && { instructions: merge(raw.instructions, o.instructions) }),
    repos: raw.repos?.map((r) => {
      const p = repoPatch(r.name);
      if (!p) return r;
      const { autoMerge, ...rest } = {
        ...r,
        ...(p.roles && { roles: mergeRoles(r.roles, p.roles) }),
        ...(p.instructions && { instructions: merge(r.instructions, p.instructions) }),
      };
      const mode = p.autoMerge === undefined ? autoMerge : (p.autoMerge ?? undefined);
      return mode === undefined ? rest : { ...rest, autoMerge: mode };
    }),
  };
}

/** The live config (REQ-003-36): readers ask for `current` each time, so a save applies from the next tick on. */
export class LiveConfig implements SettingsEditor {
  readonly base: Config;
  /** Where the overrides are kept: `<stateDir>/config.overrides.json`. */
  readonly path: string;
  private o: Overrides;
  private cfg: Config;

  /** `raw` is `config.ts`'s default export; throws a `ConfigError` when it or the overrides file is invalid. */
  constructor(
    private readonly raw: unknown,
    source: string,
  ) {
    this.base = parseConfig(raw, source);
    this.path = join(resolve(this.base.stateDir), OVERRIDES_FILE);
    this.o = readOverrides(this.path);
    this.cfg = this.merged(this.o);
  }

  get current(): Config {
    return this.cfg;
  }

  get overrides(): Overrides {
    return this.o;
  }

  save(overrides: Overrides): void {
    const o = parseOverrides(overrides, "settings");
    const cfg = this.merged(o);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(o, null, 2)}\n`);
    renameSync(tmp, this.path);
    this.o = o;
    this.cfg = cfg;
  }

  private merged(o: Overrides): Config {
    return parseConfig(applyOverrides(this.raw as ConfigInput, o), `config with ${this.path}`);
  }
}

/** `config.ts` (or `path`) with the Settings overrides of its state dir. */
export async function loadLiveConfig(path: string): Promise<LiveConfig> {
  const { raw, source } = await importConfig(path);
  return new LiveConfig(raw, source);
}
