/**
 * Harnesses (spec 006): the agent CLIs a session can run in, e.g. Claude Code, Codex CLI or OpenCode. Each adapter
 * declares the Harness features it has (REQ-006-06): every Harness has the core ones, and the optional ones
 * are used wherever a Harness declares them (REQ-006-04), never cut down to what all Harnesses share.
 */
import type { RoleSettings } from "../config.ts";

export const HARNESS_NAMES = ["claude", "codex", "antigravity", "copilot", "opencode"] as const;
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

export interface LoginStatus {
  ok: boolean;
  detail: string;
}

/**
 * A login check: a CLI command and how to read its answer, or, for a CLI without one (Copilot CLI), a look into the
 * Account's folder and the environment the CLI reads tokens from.
 */
export type LoginCheck =
  | { args: string[]; read(out: { ok: boolean; out: string }): LoginStatus }
  | { readFolder(accountDir: string, env: Record<string, string | undefined>): LoginStatus };

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
  /**
   * The variable naming an Account's config folder, e.g. `CLAUDE_CONFIG_DIR`. Absent for a Harness without a per-login
   * folder, which supports one Account in its default folder (REQ-006-09).
   */
  readonly accountEnv?: string;
  /** The config folder of an Account without its own, under the home folder (e.g. `.claude`). */
  readonly defaultAccountFolder: string;
  readonly dialogs: readonly Dialog[];
  /**
   * Writes the session's per-session config (hooks) into its folder; called on every launch, with the Role's model
   * for a Harness that takes part of it from that config (OpenCode's effort).
   */
  writeSessionConfig(o: {
    sessionDir: string;
    cwd: string;
    home: string;
    hook: (event: string) => string;
    model?: RoleSettings;
  }): void;
  /** The command line before the prompt, which the runner appends as the last argument. */
  args(o: LaunchInput): string[];
  /** Variables the CLI needs besides the Account's folder and `TMPDIR`, e.g. where its per-session config is. */
  env(o: { tmp: string; sessionDir: string }): Record<string, string>;
  /** How `bun run doctor` checks an Account's login (REQ-006-05). */
  loginCheck: LoginCheck;
  /** Copies a session's transcript to another Account's folder (feature `transcriptMove`). */
  moveTranscript?(agentSessionId: string, fromDir: string, toDir: string): boolean;
  /** A turn that ended without the turn-end hook (feature `usageLimit` without a hook for it). */
  endedTurn?(transcriptPath: string): EndedTurn | undefined;
  /**
   * A hook event and payload of this Harness as src/hook.ts handles them (Claude Code's names and fields); undefined
   * for an event it has nothing to do on. Absent: the Harness already sends them that way (e.g. Codex).
   */
  hookInput?(
    event: string,
    payload: Record<string, unknown>,
    now?: number,
  ): { event: string; payload: Record<string, unknown> } | undefined;
  /**
   * The hook script's answer to an event (after `hookInput`) in this Harness's own terms, e.g. its Stop decision; the
   * answer may be empty (e.g. OpenCode aborts a turn the usage limit ended, REQ-006-15). Empty output prints nothing.
   */
  hookOutput?(event: string, stdout: string): string;
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
