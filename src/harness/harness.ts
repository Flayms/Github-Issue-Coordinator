/**
 * Harnesses (spec 006): the agent CLIs a session can run in, e.g. Claude Code or Codex CLI. Each adapter
 * declares the Harness features it has (REQ-006-06): every Harness has the core ones, and the optional ones
 * are used wherever a Harness declares them (REQ-006-04), never cut down to what all Harnesses share.
 */
import type { RoleSettings } from "../config.ts";

export const HARNESS_NAMES = ["claude", "codex"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

/** Features every Harness provides, by the name the feature matrix shows (docs/harnesses.md). */
export const CORE_FEATURES = {
  launch: "Start in tmux, skip permissions",
  resume: "Resume by session id",
  turnEndHook: "Turn-end hook (Result validation)",
  loginCheck: "Login check (`bun run doctor`)",
} as const;

/** Features a Harness may have; the dashboard and the scheduler use them only where declared (REQ-006-04). */
export const OPTIONAL_FEATURES = {
  remoteControl: "Remote Control / Open chat",
  nowLine: "Now line from the transcript",
  usageQuota: "Usage quota meters",
  usageLimit: "Usage limit detected",
  usageLimitReset: "Usage limit with reset time",
  transcriptMove: "Transcript move on Account switch",
} as const;

export type CoreFeature = keyof typeof CORE_FEATURES;
export type OptionalFeature = keyof typeof OPTIONAL_FEATURES;
export type Feature = CoreFeature | OptionalFeature;

/** How a Harness has a feature, e.g. "`--resume`", or false when it lacks it; with why for the matrix. */
export type FeatureSupport = { has: true; how?: string } | { has: false; why: string };

/** One screen the Coordinator answers by itself, e.g. a folder trust question (REQ-005-01). */
export interface Dialog {
  screen: RegExp;
  keys: string[];
}

/** A turn that ended without the turn-end hook, found from the transcript (e.g. Codex's usage limit). */
export interface EndedTurn {
  usageLimited: boolean;
  /** When the limit resets (ISO), if the Harness reported one. */
  resetsAt?: string;
}

export interface LaunchInput {
  /** The session folder (`sessions/<id>/`), holding the per-session config. */
  sessionDir: string;
  /** The session's name, e.g. its Remote Control name (REQ-001-33). */
  name: string;
  model: RoleSettings;
  /** The Harness's session id to resume. */
  resumeId?: string;
  /** The hook command line for an event, already shell quoted. */
  hook: (event: string) => string;
}

export interface Harness {
  readonly name: HarnessName;
  /** As the docs and the dashboard name it, e.g. "Claude Code". */
  readonly label: string;
  /** The CLI on the PATH, e.g. `claude`. */
  readonly bin: string;
  /** The oldest CLI version the adapter was checked against; `bun run doctor` warns below it. */
  readonly minVersion: string;
  readonly features: Readonly<
    Record<CoreFeature, FeatureSupport & { has: true }> & Record<OptionalFeature, FeatureSupport>
  >;
  /** The variable naming an Account's config folder, e.g. `CLAUDE_CONFIG_DIR`. */
  readonly accountEnv: string;
  /** The config folder of an Account without its own, under the home folder (e.g. `.claude`). */
  readonly defaultAccountFolder: string;
  readonly dialogs: readonly Dialog[];
  /** Writes the session's per-session config (hooks) into its folder; called on every launch. */
  writeSessionConfig(o: { sessionDir: string; cwd: string; home: string; hook: (event: string) => string }): void;
  /** The command line before the prompt, which the runner appends as the last argument. */
  args(o: LaunchInput): string[];
  /** Variables the CLI needs besides the Account's folder and `TMPDIR`. */
  env(o: { tmp: string }): Record<string, string>;
  /** How `bun run doctor` checks the login, and how to read its answer. */
  loginCheck: { args: string[]; read(out: { ok: boolean; out: string }): { ok: boolean; detail: string } };
  /** Copies a session's transcript to another Account's folder (feature `transcriptMove`). */
  moveTranscript?(agentSessionId: string, fromDir: string, toDir: string): boolean;
  /** A turn that ended without the turn-end hook (feature `usageLimit` without a hook for it). */
  endedTurn?(transcriptPath: string): EndedTurn | undefined;
}

/** "1.2.3" ≥ "1.2"? Missing parts count as 0; non-numbers as 0. */
export function versionAtLeast(version: string, min: string): boolean {
  const parts = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
