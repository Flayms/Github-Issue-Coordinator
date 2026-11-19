/**
 * Role prompts (REQ-001-22) and the Owner's Extra instructions after them (REQ-002-17).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, extraInstructions, type Role } from "./config.ts";

const DEFAULT_DIR = resolve(import.meta.dir, "../prompts");

/** The repository's own `.github/coordinator/<role>.md` if present, else the default prompt. */
export function loadPrompt(role: Role, repoDir: string): string {
  const override = join(repoDir, ".github", "coordinator", `${role}.md`);
  return readFileSync(existsSync(override) ? override : join(DEFAULT_DIR, `${role}.md`), "utf8");
}

/** Replaces `{{name}}` placeholders; an unknown placeholder is an error, not silently empty. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`prompt uses unknown placeholder ${match}`);
    return value;
  });
}

/** REQ-002-17: the heading that sets the Owner's Extra instructions apart from the Role prompt. */
export const EXTRA_INSTRUCTIONS_HEADING = "## Additional instructions from the Owner";

/**
 * The prompt a new session of `role` starts with: the Role prompt (the repository's file or the default) with its
 * placeholders filled in, then the Owner's Extra instructions, inserted literally (REQ-002-17). The runner appends
 * the Result instruction after it.
 */
export function rolePrompt(
  config: Config,
  role: Role,
  repoDir: string,
  vars: { repo: string; context: string },
): string {
  const prompt = renderPrompt(loadPrompt(role, repoDir), vars);
  const extra = extraInstructions(config, vars.repo, role);
  if (!extra.length) return prompt;
  return [
    prompt,
    EXTRA_INSTRUCTIONS_HEADING,
    "The Owner added these for this Role. They add to the instructions above: follow them, unless one would break a rule above; then keep the rule and say so in your Result.",
    ...extra,
  ].join("\n\n");
}
