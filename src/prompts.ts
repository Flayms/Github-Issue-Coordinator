/**
 * Role prompts (REQ-001-22) and the permissions each Role runs with (REQ-001-25).
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

export interface Permissions {
  permissionMode: "dontAsk" | "auto";
  /** Pre-approved tools; in `dontAsk` mode everything else is denied without a prompt. */
  allowedTools: string[];
  /** Run Bash inside Claude Code's sandbox. */
  sandbox: boolean;
}

const READ_ONLY = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git grep:*)",
  "Bash(git blame:*)",
  "Bash(git ls-files:*)",
  "WebSearch",
  "WebFetch",
];

/** Sessions don't wait for routine permission prompts (REQ-001-25). */
export function rolePermissions(role: Role, sessionDir: string): Permissions {
  // Auto mode decides on its own; what it won't allow is left to the Owner in the Claude app.
  if (role === "implementer") return { permissionMode: "auto", allowedTools: [], sandbox: true };
  // Permission rules take absolute paths with a leading `//`.
  const result = `/${join(sessionDir, "result.json")}`;
  return {
    permissionMode: "dontAsk",
    allowedTools: [...READ_ONLY, `Write(${result})`, `Edit(${result})`],
    // REQ-001-26: even read-only git can print any file (`git diff --no-index`), so their shell runs sandboxed too.
    sandbox: true,
  };
}
