/**
 * The Model catalogue (REQ-003-40, REQ-003-41): the models the Config page offers, and how the dashboard
 * names a model. `config.json` may still name any model; only the Config page is limited to this list.
 * Each model belongs to one Harness, which runs it (REQ-006-01).
 */
import { COPILOT_MODEL_PREFIX } from "./harness/copilot.ts";
import type { HarnessName } from "./harness/harness.ts";
import { OPENCODE_MODEL_PREFIX } from "./harness/opencode.ts";

const FAMILIES = ["opus", "sonnet", "haiku", "fable"];
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "Opus 5.5" for `claude-opus-5-5`; also handles date suffixes (`claude-haiku-4-5-20251001`),
 * the old order (`claude-3-5-sonnet-20241022`) and a context suffix (`[1m]`).
 * Undefined for an alias such as `opus` or an unknown id.
 */
export function modelDisplayName(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const parts = modelId
    .toLowerCase()
    .replace(/\[.*\]$/, "")
    .split("-");
  if (parts[0] !== "claude") return undefined;
  const family = parts.find((p) => FAMILIES.includes(p));
  // Version parts are short numbers; a date suffix (8 digits) is not part of the version.
  const version = parts.filter((p) => /^\d{1,2}$/.test(p));
  if (!family || version.length === 0) return undefined;
  return `${capitalise(family)} ${version.join(".")}`;
}

export interface CatalogueModel {
  /** What `claude --model` gets, e.g. `opus` or `claude-opus-5-5`. */
  value: string;
  /** "Opus (latest)" for an alias, "Opus 5.5" for a pinned version. */
  label: string;
  /** An alias follows new releases; a pinned version stays. */
  alias: boolean;
}

/**
 * Update when a model ships: aliases follow new releases by themselves, pinned versions don't.
 * Families as `claude --model` names them; pinned ids as the Anthropic docs list them.
 */
const ALIASES = ["fable", "opus", "sonnet", "haiku"];
const PINNED = ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

/** The alias's family, e.g. `opus` for `Opus`; undefined for anything else. */
const aliasFamily = (value: string): string | undefined => {
  const v = value.toLowerCase();
  return ALIASES.includes(v) ? v : undefined;
};

/**
 * Codex CLI's models, as `codex debug models` of Codex CLI 0.170.0 lists them (visibility `list`). Codex has no
 * aliases; update when a model ships.
 */
const CODEX_MODELS: readonly CatalogueModel[] = [
  ["gpt-6.2-sol", "GPT-6.2-Sol"],
  ["gpt-6.2-astra", "GPT-6.2-Astra"],
  ["gpt-6.1-sol", "GPT-6.1-Sol"],
  ["gpt-6.1-terra", "GPT-6.1 Terra"],
  ["gpt-6-sol", "GPT-6-Sol"],
  ["gpt-6-astra", "GPT-6-Astra"],
  ["gpt-6-luna", "GPT-6-Luna"],
  ["gpt-5.6-sol", "GPT-5.6-Sol"],
  ["gpt-5.6-terra", "GPT-5.6-Terra"],
  ["gpt-5.6-luna", "GPT-5.6-Luna"],
  ["gpt-5.5", "GPT-5.5"],
].map(([value, label]) => ({ value: value as string, label: label as string, alias: false }));

/**
 * Copilot CLI's models, from the catalogue bundled with Copilot CLI 1.0.114; which of them a login may use depends on
 * its plan. Each carries the `copilot:` prefix, so a Role picks the Harness, its Account and its quota deliberately
 * even where another Harness runs the same model (e.g. Claude Sonnet). `auto` lets Copilot pick per request.
 */
const COPILOT_MODELS: readonly CatalogueModel[] = [
  ["auto", "Auto"],
  ["claude-opus-5.5", "Claude Opus 5.5"],
  ["claude-sonnet-5.5", "Claude Sonnet 5.5"],
  ["claude-haiku-5.5", "Claude Haiku 5.5"],
  ["gpt-6.1-sol", "GPT-6.1-Sol"],
  ["gpt-6.1-terra", "GPT-6.1 Terra"],
  ["gpt-6-luna", "GPT-6-Luna"],
  ["gemini-4-argon", "Gemini 4 Argon"],
  ["grok-4.7", "Grok 4.7"],
].map(([id, name]) => ({ value: `${COPILOT_MODEL_PREFIX}${id}`, label: `${name} (Copilot)`, alias: false }));

/**
 * Antigravity CLI's Gemini models, as `agy models` of Antigravity CLI 1.5.12 lists them, without the effort suffix
 * (`-low` … `-xhigh`), so a Role's effort applies (REQ-006-07). A Google login may offer more, which `config.json` can
 * still name. Update when a model ships.
 */
const ANTIGRAVITY_MODELS: readonly CatalogueModel[] = [
  ["gemini-4-neon", "Gemini 4 Neon"],
  ["gemini-4-carbon", "Gemini 4 Carbon"],
  ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
  ["gemini-4-argon", "Gemini 4 Argon"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-3.7-flash", "Gemini 3.7 Flash"],
  ["gemini-3.6-flash", "Gemini 3.6 Flash"],
].map(([value, label]) => ({ value: value as string, label: label as string, alias: false }));

/**
 * OpenCode's free models on its own Zen gateway, as `opencode models opencode` of OpenCode 1.19.6 lists them without a
 * login. Free models come and go; `config.json` may name any model OpenCode reaches as `opencode:<provider>/<model>`
 * (e.g. `opencode:anthropic/claude-sonnet-5-5` with that provider's key or login).
 */
const OPENCODE_MODELS: readonly CatalogueModel[] = [
  ["big-pickle", "Big Pickle"],
  ["beam-free", "Beam Free"],
  ["deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash Free"],
  ["flint-40b-free", "Flint 40B Free"],
  ["glm-5.3-flash-free", "GLM-5.3-Flash Free"],
  ["hy4-flash-free", "Hy4 flash Free"],
  ["iceman-free", "Iceman Free"],
  ["inkling-2-small-free", "Inkling 2 Small Free"],
  ["longcat-2.5-free", "LongCat 2.5 Free"],
  ["mimo-v2.6-flash-free", "MiMo-V2.6-Flash Free"],
  ["nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free"],
  ["nemotron-3.5-super-vl-free", "Nemotron 3.5 Super VL Free"],
].map(([id, name]) => ({ value: `${OPENCODE_MODEL_PREFIX}opencode/${id}`, label: `${name} (OpenCode)`, alias: false }));

/** Claude Code's models. */
export const MODEL_CATALOGUE: readonly CatalogueModel[] = [
  ...ALIASES.map((value) => ({ value, label: modelLabel(value), alias: true })),
  ...PINNED.map((value) => ({ value, label: modelLabel(value), alias: false })),
];

/** REQ-006-01: every Harness's models, in the order the Config page groups them. */
export const HARNESS_MODELS: Readonly<Record<HarnessName, readonly CatalogueModel[]>> = {
  claude: MODEL_CATALOGUE,
  codex: CODEX_MODELS,
  antigravity: ANTIGRAVITY_MODELS,
  copilot: COPILOT_MODELS,
  opencode: OPENCODE_MODELS,
};

const ALL_MODELS = Object.values(HARNESS_MODELS).flat();

export const inCatalogue = (value: string): boolean => ALL_MODELS.some((m) => m.value === value);

/**
 * REQ-006-01: the Harness that runs a model: its catalogue's, else Copilot CLI for a `copilot:` model (REQ-006-10),
 * OpenCode for an `opencode:` one (REQ-006-14), else
 * Codex for OpenAI's naming (`gpt-…`, `o3`, `codex-…`), Antigravity for Google's (`gemini-…`, REQ-006-07), else Claude
 * Code, which also takes any model a gateway offers.
 */
export function harnessOfModel(value: string): HarnessName {
  for (const [name, models] of Object.entries(HARNESS_MODELS))
    if (models.some((m) => m.value === value)) return name as HarnessName;
  if (value.startsWith(COPILOT_MODEL_PREFIX)) return "copilot";
  if (value.startsWith(OPENCODE_MODEL_PREFIX)) return "opencode";
  if (/^(gpt-|o\d|codex-)/i.test(value)) return "codex";
  return /^gemini-/i.test(value) ? "antigravity" : "claude";
}

/**
 * How the dashboard names a model (REQ-003-41): "Opus 5.5" for `claude-opus-5-5`, "Opus (latest)" for
 * `opus`, ", 1M context" for a `[1m]` suffix, "(Copilot)" after a Copilot model (REQ-006-10), "(OpenCode)" after an
 * OpenCode one (REQ-006-14); anything else as it is.
 */
export function modelLabel(value: string): string {
  if (value.startsWith(OPENCODE_MODEL_PREFIX))
    return (
      OPENCODE_MODELS.find((m) => m.value === value)?.label ?? `${value.slice(OPENCODE_MODEL_PREFIX.length)} (OpenCode)`
    );
  if (value.startsWith(COPILOT_MODEL_PREFIX))
    return (
      COPILOT_MODELS.find((m) => m.value === value)?.label ?? `${value.slice(COPILOT_MODEL_PREFIX.length)} (Copilot)`
    );
  const suffix = /\[(.*)\]$/.exec(value)?.[1];
  const bare = suffix === undefined ? value : value.slice(0, -suffix.length - 2);
  const otherName = [...CODEX_MODELS, ...ANTIGRAVITY_MODELS].find((m) => m.value === bare)?.label;
  if (otherName && suffix === undefined) return otherName;
  const family = aliasFamily(bare);
  const name = modelDisplayName(bare) ?? (family && `${capitalise(family)} (latest)`);
  if (!name) return value;
  if (suffix === undefined) return name;
  return suffix.toLowerCase() === "1m" ? `${name}, 1M context` : `${name} [${suffix}]`;
}

const version = (name: string): number[] => (name.split(" ")[1] ?? "").split(".").map(Number);

const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/**
 * What an alias currently means: the newest version of its family among the models the sessions reported
 * (REQ-001-29), e.g. "Opus 5.5" for `opus`; undefined for a pinned model or when none was reported.
 */
export function latestReported(value: string, reported: readonly string[]): string | undefined {
  const family = aliasFamily(value);
  if (!family) return undefined;
  let best: string | undefined;
  for (const id of reported) {
    const name = modelDisplayName(id);
    if (!name || name.split(" ")[0]?.toLowerCase() !== family) continue;
    if (!best || newer(version(name), version(best))) best = name;
  }
  return best;
}

/** A model's option on the Config page: its label, for an alias followed by what it currently means. */
export function modelOptionLabel(value: string, reported: readonly string[]): string {
  const now = latestReported(value, reported);
  return now ? `${modelLabel(value)} · now ${now}` : modelLabel(value);
}
