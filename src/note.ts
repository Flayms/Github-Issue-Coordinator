/**
 * The note every comment, PR and review by the Coordinator starts with (AGENTS.md, REQ-001-29).
 */
import { type Config, type Role, roleSettings } from "./config.ts";
import type { SessionRecord } from "./store.ts";

/** Role names as the glossary spells them. */
export const ROLE_NAMES: Record<Role, string> = {
  planner: "Planner",
  implementer: "Implementer",
  reviewer: "Reviewer",
};

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

/** The model as the note names it: its version if known, else the configured model (an alias). */
function modelName(modelId: string | undefined, alias: string | undefined): string {
  const name = modelDisplayName(modelId) ?? modelDisplayName(alias);
  if (name) return `Claude ${name}`;
  const plain = alias?.replace(/\[.*\]$/, "").trim();
  return plain ? `Claude ${capitalise(plain)}` : "Claude";
}

/**
 * Without a Role, the note of the Coordinator's own messages; with one, the note of that Role's session,
 * naming the model it ran (`modelId`) or, if unknown, the configured model (`alias`).
 */
export function agentNote(by: { owner: string; role?: Role; modelId?: string; alias?: string }): string {
  const who = by.role ? `${modelName(by.modelId, by.alias)} (${ROLE_NAMES[by.role]})` : "Coordinator";
  return `> [!Note]\n> 🤖 ${who} writing on behalf of ${by.owner}`;
}

/** The note for a session's messages. */
export const sessionNote = (config: Config, session: SessionRecord): string =>
  agentNote({
    owner: config.owner.login,
    role: session.role,
    modelId: session.modelId ?? undefined,
    alias: roleSettings(config, session.repo, session.role).model,
  });
