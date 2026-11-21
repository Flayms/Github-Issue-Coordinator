/**
 * The Copilot CLI Harness (REQ-006-10): interactive `copilot` sessions with every tool, path and URL allowed
 * (REQ-005-01). Its hooks come from a plugin in the session folder (`--plugin-dir`), so nothing is written into the
 * Worktree or the Account's `COPILOT_HOME`. Checked against Copilot CLI 1.0.114 and a fake model server
 * (docs/harnesses.md).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness, LoginStatus } from "./harness.ts";

/**
 * Copilot runs hooks under Claude Code's event names with Claude Code's payload fields (`session_id`,
 * `transcript_path`), so src/hook.ts serves them as it does Claude's (test/fixtures/copilot/hooks.json).
 */
export const COPILOT_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const;

/** REQ-006-12: Copilot's own event for a failed model call; no Stop fires when a rate limit ends the turn. */
export const COPILOT_ERROR_EVENT = "errorOccurred";

/** Model values in the Model catalogue carry this prefix, so they stay apart from other Harnesses' models. */
export const COPILOT_MODEL_PREFIX = "copilot:";

/** Variables Copilot takes a token from, before a stored login, in its order (`copilot help environment`). */
const TOKEN_ENV = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

const pluginDir = (sessionDir: string) => join(sessionDir, "copilot-plugin");

/**
 * REQ-006-13: Copilot has no command that reports the login. `copilot login` stores the account in
 * `<COPILOT_HOME>/config.json` (`loggedInUsers`; the token in the keyring or that file), a JSON file with `//` comments.
 */
export function copilotLogin(accountDir: string, env: Record<string, string | undefined>): LoginStatus {
  const token = TOKEN_ENV.find((v) => env[v]);
  if (token) return { ok: true, detail: `token in ${token}` };
  let users: unknown;
  try {
    const text = readFileSync(join(accountDir, "config.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    users = (JSON.parse(text) as { loggedInUsers?: unknown }).loggedInUsers;
  } catch {
    users = undefined;
  }
  const login = Array.isArray(users) ? (users[0] as { login?: unknown } | undefined)?.login : undefined;
  if (typeof login === "string" && login) return { ok: true, detail: login };
  return {
    ok: false,
    detail:
      "run it with the `login` subcommand (without one, Copilot falls back to the GitHub CLI's token, which needs " +
      'the "Copilot Requests" permission)',
  };
}

/**
 * Copilot keeps a session in `<COPILOT_HOME>/session-state/<id>/`, and `--resume <id>` finds it in another
 * `COPILOT_HOME` at the same place (checked with Copilot CLI 1.0.114). Returns whether there was one.
 */
export function copySessionState(agentSessionId: string, fromDir: string, toDir: string): boolean {
  const from = join(fromDir, "session-state", agentSessionId);
  if (!existsSync(from)) return false;
  // Lock files of the process that last had the session open; Copilot recreates them.
  cpSync(from, join(toDir, "session-state", agentSessionId), {
    recursive: true,
    filter: (src) => !/[/\\]inuse\.\d+\.(hold|lock)$/.test(src),
  });
  return true;
}

export const copilot: Harness = {
  name: "copilot",
  label: "Copilot CLI",
  bin: "copilot",
  minVersion: "1.0.114",
  features: {
    launch: { has: true, how: "`--allow-all`" },
    resume: { has: true, how: "`--resume <id>`" },
    turnEndHook: { has: true, how: "`Stop` (`agentStop`)" },
    loginCheck: { has: true, how: "`config.json` of the Account" },
    remoteControl: { has: false, why: "Copilot's `/remote on` could link a session to GitHub; not wired up yet" },
    nowLine: { has: false, why: "the session's event log differs from Claude's transcript; not read yet" },
    usageQuota: { has: false, why: "Copilot shows it only in `/usage`; not read yet" },
    usageLimit: { has: true, how: "`errorOccurred`" },
    usageLimitReset: { has: false, why: "not in the hook's payload; the Account pauses for the default interval" },
    transcriptMove: { has: true, how: "`session-state/<id>/` copied" },
  },
  accountEnv: "COPILOT_HOME",
  defaultAccountFolder: ".copilot",
  // COPILOT_ALLOW_ALL=true trusts the folder, so no trust dialog comes up (see env).
  dialogs: [],

  /** The per-session plugin holding the hooks, rewritten on every launch. */
  writeSessionConfig({ sessionDir, hook }) {
    const dir = pluginDir(sessionDir);
    mkdirSync(join(dir, ".plugin"), { recursive: true });
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(
      join(dir, ".plugin", "plugin.json"),
      JSON.stringify({ name: "issueflow-session", version: "1.0.0", description: "Coordinator session hooks" }),
    );
    const hooks: Record<string, unknown[]> = Object.fromEntries(
      COPILOT_HOOK_EVENTS.map((ev) => [ev, [{ hooks: [{ type: "command", command: hook(ev) }] }]]),
    );
    // Copilot's own event names take Copilot's own entry format.
    hooks[COPILOT_ERROR_EVENT] = [{ type: "command", bash: hook(COPILOT_ERROR_EVENT) }];
    writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks }, null, 2));
  },

  args({ sessionDir, model, resumeId }) {
    // `--resume <id>` fails on an unknown id; `--continue` would take the latest session, ambiguous across Worktrees.
    const args: string[] = resumeId ? ["--resume", resumeId] : [];
    // REQ-005-01: agents run unrestricted on the Coordinator's VM.
    args.push("--plugin-dir", pluginDir(sessionDir), "--allow-all");
    args.push(
      "--model",
      model.model.startsWith(COPILOT_MODEL_PREFIX) ? model.model.slice(COPILOT_MODEL_PREFIX.length) : model.model,
    );
    if (model.effort) args.push("--reasoning-effort", model.effort);
    // An interactive session that starts with the prompt the runner appends.
    args.push("-i");
    return args;
  },

  // Exactly "true" also trusts the working folder, so the trust dialog doesn't stop the session (`copilot help
  // environment`). The folder's own hooks then run too, as with Claude Code (docs/known-pitfalls.md).
  env: () => ({ COPILOT_ALLOW_ALL: "true" }),

  loginCheck: { readFolder: copilotLogin },

  moveTranscript: copySessionState,
};
