/**
 * Role prompts (REQ-001-22).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Role } from "./config.ts";

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
