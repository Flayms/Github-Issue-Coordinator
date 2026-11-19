/**
 * Accounts (spec 004): the subscriptions sessions run on, each logged in in its own config folder of its Harness
 * (spec 006). A usage limit pauses one Account; work moves on to the next of the same Harness (REQ-001-17, REQ-006-02).
 */
import { join } from "node:path";
import { HARNESSES } from "./harness/index.ts";
import type { HarnessName } from "./harness/harness.ts";

export { copyTranscript } from "./harness/claude.ts";

export interface Account {
  name: string;
  /** The Harness this login is for (REQ-006-02); absent: Claude Code. */
  harness?: HarnessName;
  /** The Harness's config folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); absent: its default, e.g. `~/.claude`. */
  configDir?: string;
}

/** The implicit Account of a config without `accounts`: Claude's default folder, as before spec 004. */
export const DEFAULT_ACCOUNT: Account = { name: "default" };

/** REQ-006-02: the Harness an Account belongs to. */
export const harnessOfAccount = (a: Account): HarnessName => a.harness ?? "claude";

/** REQ-006-02: the Accounts of one Harness, in config order. */
export const accountsOf = (accounts: readonly Account[], harness: HarnessName): Account[] =>
  accounts.filter((a) => harnessOfAccount(a) === harness);

/** The folder holding the Account's login and transcripts. */
export const accountDir = (a: Account, home: string): string =>
  a.configDir ?? join(home, HARNESSES[harnessOfAccount(a)].defaultAccountFolder);

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
