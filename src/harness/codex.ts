/**
 * The Codex CLI Harness (REQ-006-01): interactive `codex` sessions with every approval and the sandbox skipped
 * (REQ-005-01). Hooks are passed per session as `-c hooks.<Event>=…` overrides, so nothing is written into the
 * Account's `CODEX_HOME`. Checked against Codex CLI 0.170.0 and a fake model server (docs/harnesses.md).
 */
import { closeSync, cpSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { EndedTurn, Harness } from "./harness.ts";

/** Codex fires these with the same names and payload fields Claude Code uses (test/fixtures/codex/hooks.json). */
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const;

/** Only the rollout's tail is read for the end of the last turn. */
const TAIL_BYTES = 64 * 1024;

/** `-c` takes a TOML value; a JSON string is a valid TOML basic string. */
const hookOverride = (event: string, command: string): string =>
  `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)}}]}]`;

/**
 * How the last turn in a Codex rollout ended, when it ended without a Stop hook: Codex fires no Stop when the usage
 * limit ends a turn, and writes `task_complete` with `error.codex_error_info: "usage_limit_exceeded"` instead.
 * Undefined while a turn runs or when the last one ended normally.
 */
export function codexEndedTurn(transcriptPath: string): EndedTurn | undefined {
  let fd: number | undefined;
  let text: string;
  try {
    fd = openSync(transcriptPath, "r");
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: unknown; payload?: { type?: unknown; error?: { codex_error_info?: unknown } } };
    try {
      entry = JSON.parse(lines[i] ?? "");
    } catch {
      continue;
    }
    if (entry?.type !== "event_msg") continue;
    const kind = entry.payload?.type;
    if (kind === "task_started") return undefined;
    if (kind !== "task_complete") continue;
    return entry.payload?.error?.codex_error_info === "usage_limit_exceeded" ? { usageLimited: true } : undefined;
  }
  return undefined;
}

/**
 * Codex keeps a session's rollout in `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, and `codex resume`
 * finds it in another `CODEX_HOME` at the same place (checked with Codex CLI 0.170.0). Returns whether there was one.
 */
export function copyRollout(agentSessionId: string, fromDir: string, toDir: string): boolean {
  const root = join(fromDir, "sessions");
  if (!existsSync(root)) return false;
  let copied = false;
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(`-${agentSessionId}.jsonl`)) continue;
    const from = join(root, file);
    cpSync(from, join(toDir, "sessions", relative(root, from)));
    copied = true;
  }
  return copied;
}

export const codex: Harness = {
  name: "codex",
  label: "Codex CLI",
  bin: "codex",
  minVersion: "0.170.0",
  features: {
    launch: { has: true, how: "`--dangerously-bypass-approvals-and-sandbox`" },
    resume: { has: true, how: "`codex resume`" },
    turnEndHook: { has: true, how: "`Stop`" },
    loginCheck: { has: true, how: "`codex login status`" },
    remoteControl: { has: false, why: "Codex has no link into a phone or web app; attach to tmux instead" },
    nowLine: { has: false, why: "the rollout format differs from Claude's transcript; not read yet" },
    usageQuota: { has: false, why: "Codex writes `rate_limits` into its rollout; not read yet" },
    usageLimit: { has: true, how: "rollout `task_complete` error" },
    usageLimitReset: { has: false, why: "only in the message text; the Account pauses for the default interval" },
    transcriptMove: { has: true, how: "rollout copied" },
  },
  accountEnv: "CODEX_HOME",
  defaultAccountFolder: ".codex",
  dialogs: [
    // The first session in a folder asks once per `CODEX_HOME`; "1. Trust and continue" is preselected.
    { screen: /Trust this folder\?[\s\S]*1\. Trust and continue/, keys: ["Enter"] },
  ],

  // Nothing to write: the hooks go on the command line.
  writeSessionConfig() {},

  args({ model, resumeId, hook }) {
    const args: string[] = resumeId ? ["resume", resumeId] : [];
    // REQ-005-01: agents run unrestricted on the Coordinator's VM; the per-session hooks need no trust prompt.
    args.push("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust");
    args.push("--model", model.model);
    if (model.effort) args.push("-c", `model_reasoning_effort="${model.effort}"`);
    for (const ev of CODEX_HOOK_EVENTS) args.push("-c", hookOverride(ev, hook(ev)));
    return args;
  },

  env: () => ({}),

  // Exits 0 with "Logged in using …" when credentials are present, 1 with "Not logged in" otherwise.
  loginCheck: {
    args: ["login", "status"],
    read: ({ ok, out }) => ({
      ok,
      detail: ok ? out.split("\n")[0] || "logged in" : "run it with the `login` subcommand",
    }),
  },

  moveTranscript: copyRollout,
  endedTurn: codexEndedTurn,
};
