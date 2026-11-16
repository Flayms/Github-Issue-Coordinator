/**
 * Accounts (spec 004): the Claude subscriptions sessions run on, each logged in in its own Claude
 * config folder. A usage limit pauses one Account; work moves on to the next (REQ-001-17).
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Account {
  name: string;
  /** Claude's config folder (`CLAUDE_CONFIG_DIR`); absent: Claude's default `~/.claude`. */
  configDir?: string;
}

/** The implicit Account of a config without `accounts`: Claude's default folder, as before spec 004. */
export const DEFAULT_ACCOUNT: Account = { name: "default" };

/** The folder holding the Account's login and transcripts. */
export const accountDir = (a: Account, home: string): string => a.configDir ?? join(home, ".claude");

const pausedAt = (until: string | undefined, now: Date): until is string =>
  until !== undefined && Date.parse(until) > now.getTime();

/** REQ-004-01: the first Account in config order that isn't paused. */
export function freeAccount(
  accounts: Account[],
  pausedUntil: (name: string) => string | undefined,
  now: Date,
): Account | undefined {
  return accounts.find((a) => !pausedAt(pausedUntil(a.name), now));
}

/** REQ-001-17: while every Account is paused, when the first of them is free again; otherwise undefined. */
export function allPausedUntil(
  accounts: Account[],
  pausedUntil: (name: string) => string | undefined,
  now: Date,
): string | undefined {
  const ends = accounts.map((a) => pausedUntil(a.name));
  if (!ends.every((u) => pausedAt(u, now))) return undefined;
  return (ends as string[]).sort((x, y) => Date.parse(x) - Date.parse(y))[0];
}

/**
 * Claude keeps a session's transcript in `<config folder>/projects/<cwd>/<id>.jsonl` (plus an `<id>/`
 * folder for subagents) and `--resume` looks only there, so a session moving to another Account takes
 * them along. Returns whether there was a transcript to copy.
 */
export function copyTranscript(claudeSessionId: string, fromDir: string, toDir: string): boolean {
  const projects = join(fromDir, "projects");
  if (!existsSync(projects)) return false;
  let copied = false;
  for (const project of readdirSync(projects)) {
    const file = join(projects, project, `${claudeSessionId}.jsonl`);
    if (!existsSync(file)) continue;
    cpSync(file, join(toDir, "projects", project, `${claudeSessionId}.jsonl`));
    const sub = join(projects, project, claudeSessionId);
    if (existsSync(sub)) cpSync(sub, join(toDir, "projects", project, claudeSessionId), { recursive: true });
    copied = true;
  }
  return copied;
}
