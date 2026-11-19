/**
 * The note every comment, PR and review by the Coordinator starts with (AGENTS.md, REQ-001-29).
 */
import { type Config, type Role, roleSettings } from "./config.ts";
import { harnessOfModel, modelDisplayName, modelLabel } from "./models.ts";

export { modelDisplayName } from "./models.ts";

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

import type { SessionRecord } from "./store.ts";

/** Role names as the glossary spells them. */
export const ROLE_NAMES: Record<Role, string> = {
  planner: "Planner",
  implementer: "Implementer",
  reviewer: "Reviewer",
};

/** The model as the note names it: its version if known, else the configured model (an alias). */
function modelName(modelId: string | undefined, alias: string | undefined): string {
  // REQ-006-01: a model of another Harness is named as that Harness names it, e.g. "GPT-6.2-Sol".
  const model = modelId ?? alias;
  if (model && harnessOfModel(model) !== "claude") return modelLabel(model);
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

/**
 * REQ-005-03: whether a comment or review body starts with an agent note, i.e. the Coordinator posted it. With the
 * Owner's own PAT its author is the Owner, so this is what keeps it from counting as the Owner's input.
 */
export const isAgentNote = (body: string): boolean => /^> \[!Note\]\r?\n> 🤖 /.test(body.trimStart());

/** The note for a session's messages. */
export const sessionNote = (config: Config, session: SessionRecord): string =>
  agentNote({
    owner: config.owner.login,
    role: session.role,
    modelId: session.modelId ?? undefined,
    alias: roleSettings(config, session.repo, session.role).model,
  });
