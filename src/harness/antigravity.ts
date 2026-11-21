/**
 * The Antigravity CLI Harness (REQ-006-07): interactive `agy` sessions with every permission prompt skipped
 * (REQ-005-01). Antigravity loads hooks only from a workspace folder's `.agents/hooks.json` (or the user's global one),
 * so the session folder is added as a second workspace folder holding them, and a per-session `--settings` trusts both
 * folders. Nothing is written into the Worktree or the user's `~/.gemini`. Checked with Antigravity CLI 1.5.12 against a
 * fake Gemini API endpoint (docs/harnesses.md).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "./harness.ts";

/** The events the hooks file registers; PreInvocation stands in for Claude Code's UserPromptSubmit. */
export const ANTIGRAVITY_HOOK_EVENTS = ["SessionStart", "PreInvocation", "Stop"] as const;

/** `agy` refuses `--effort` with a model id that names its own effort, e.g. `gemini-4-neon-high`. */
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

/** A quota error in the Stop payload's `error`, e.g. "Error 429, … Status: RESOURCE_EXHAUSTED". */
const QUOTA_ERROR = /RESOURCE_EXHAUSTED|Error 429\b/;

const settingsPath = (sessionDir: string) => join(sessionDir, "agy-settings.json");

/**
 * REQ-006-08: when a quota error says the limit resets, from its `retryDelay:<seconds>s` (gRPC RetryInfo); undefined
 * when it gives none.
 */
export function retryDelayResetTime(error: string, now: number): string | undefined {
  const seconds = /retryDelay:(\d+(?:\.\d+)?)s/.exec(error)?.[1];
  return seconds ? new Date(now + Number(seconds) * 1000).toISOString() : undefined;
}

/**
 * Antigravity's hook payloads in the shape src/hook.ts handles (Claude Code's): camelCase fields renamed, the first
 * model call of a turn as UserPromptSubmit, a Stop on a quota error as StopFailure with `error: "rate_limit"`.
 * Undefined for an event the hook script has nothing to do on, e.g. a later model call in the same turn.
 */
export function antigravityHookInput(
  event: string,
  payload: Record<string, unknown>,
  now = Date.now(),
): { event: string; payload: Record<string, unknown> } | undefined {
  const common = {
    ...payload,
    session_id: payload.conversationId,
    model: payload.modelName,
    transcript_path: payload.transcriptPath,
  };
  if (event === "PreInvocation")
    return payload.invocationNum === 0 ? { event: "UserPromptSubmit", payload: common } : undefined;
  if (event === "Stop") {
    const error = typeof payload.error === "string" ? payload.error : "";
    if (payload.terminationReason === "ERROR" && QUOTA_ERROR.test(error))
      return {
        event: "StopFailure",
        payload: { ...common, error: "rate_limit", resets_at: retryDelayResetTime(error, now) },
      };
  }
  return { event, payload: common };
}

export const antigravity: Harness = {
  name: "antigravity",
  label: "Antigravity CLI",
  bin: "agy",
  minVersion: "1.5.12",
  features: {
    launch: { has: true, how: "`--dangerously-skip-permissions`" },
    resume: { has: true, how: "`--conversation`" },
    turnEndHook: { has: true, how: "`Stop`" },
    loginCheck: { has: true, how: "`agy models`" },
    remoteControl: {
      has: false,
      why: "`agy --remote-control` exists, but its link isn't read yet; attach to tmux instead",
    },
    nowLine: { has: false, why: "its transcript format differs from Claude's; not read yet" },
    usageQuota: { has: false, why: "Antigravity shows the quota only in its `/usage` panel" },
    usageLimit: { has: true, how: "`Stop` error" },
    usageLimitReset: { has: true, how: "`retryDelay` of the error" },
    transcriptMove: {
      has: false,
      why: "one Account only: the login is per user (keyring or a file in the home folder), with no folder variable",
    },
  },
  // No accountEnv: Antigravity has no per-login folder, so it supports one Account (REQ-006-09).
  defaultAccountFolder: ".gemini",
  loginStep: () => "agy    then sign in and finish its first-run screens",
  // The folder trust question is answered by `trustedWorkspaces` in the session's settings.
  dialogs: [],

  writeSessionConfig({ sessionDir, cwd, hook }) {
    const agents = join(sessionDir, ".agents");
    mkdirSync(agents, { recursive: true });
    const handlers = Object.fromEntries(
      ANTIGRAVITY_HOOK_EVENTS.map((ev) => [ev, [{ type: "command", command: hook(ev) }]]),
    );
    writeFileSync(join(agents, "hooks.json"), JSON.stringify({ issueflow: handlers }, null, 2));
    // Session-only settings, never saved: workspace hooks load only in trusted folders, and the agent must not wait
    // for a review of its plan (REQ-005-01).
    const settings = {
      trustedWorkspaces: [cwd, sessionDir],
      artifactReviewPolicy: "always-proceed",
      allowNonWorkspaceAccess: true,
      showFeedbackSurvey: false,
    };
    writeFileSync(settingsPath(sessionDir), JSON.stringify(settings, null, 2));
  },

  args({ sessionDir, model, resumeId }) {
    const args: string[] = resumeId ? ["--conversation", resumeId] : [];
    // REQ-005-01: agents run unrestricted on the Coordinator's VM.
    args.push("--settings", settingsPath(sessionDir), "--add-dir", sessionDir, "--dangerously-skip-permissions");
    args.push("--model", model.model);
    if (model.effort && !EFFORT_SUFFIX.test(model.model)) args.push("--effort", model.effort);
    // The runner appends the prompt: `-i` runs it and keeps the session open.
    args.push("-i");
    return args;
  },

  env: () => ({}),

  // `agy` has no login status command; `agy models` lists the models when signed in and exits 1 otherwise.
  loginCheck: {
    args: ["models"],
    read: ({ ok }) => (ok ? { ok, detail: "signed in" } : { ok, detail: "run it without arguments and sign in" }),
  },

  hookInput: antigravityHookInput,

  // A Stop blocked by the hook script ("block") becomes Antigravity's "continue", which re-enters the loop.
  hookOutput(event, stdout) {
    if (event !== "Stop") return stdout;
    try {
      const out = JSON.parse(stdout) as { decision?: string; reason?: string };
      return out.decision === "block" ? JSON.stringify({ decision: "continue", reason: out.reason }) : stdout;
    } catch {
      return stdout;
    }
  },
};
