/**
 * The Claude Code Harness: interactive `claude --remote-control` sessions, so each shows up in the Owner's Claude app
 * (REQ-001-18). Hooks and the status line come from a per-session `--settings` file.
 */
import { cpSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RoleSettings } from "../config.ts";
import type { Harness } from "./harness.ts";

// REQ-001-17: StopFailure fires instead of Stop when an API error (e.g. the usage limit) ends the turn.
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "Notification",
  "SessionEnd",
] as const;

/**
 * REQ-005-07: the instruction files of every folder above a session's own, for `claudeMdExcludes`. Claude Code loads
 * CLAUDE.md from each of them, so a Worktree inside the Coordinator's checkout would load the Coordinator's own
 * instructions and stop at the screen asking about their imports (#87). The Owner's own `~/.claude` still loads.
 */
export function parentInstructionFiles(cwd: string, home: string): string[] {
  const files: string[] = [];
  const userDir = resolve(home);
  for (let dir = dirname(resolve(cwd)); ; dir = dirname(dir)) {
    const at = dir === "/" ? "" : dir;
    files.push(`${at}/CLAUDE.md`, `${at}/CLAUDE.local.md`);
    if (dir !== userDir) files.push(`${at}/.claude/CLAUDE.md`, `${at}/.claude/rules/**`);
    if (dirname(dir) === dir) return files;
  }
}

/** The arguments before the prompt, which the runner appends from the session's prompt file (REQ-001-45). */
export function claudeArgs(o: { name: string; settingsPath: string; model: RoleSettings; resumeId?: string }): string[] {
  const args: string[] = [];
  if (o.resumeId) args.push("--resume", o.resumeId);
  // REQ-005-01: agents run unrestricted on the Coordinator's VM.
  args.push("--settings", o.settingsPath, "--remote-control", o.name, "--dangerously-skip-permissions");
  // The prompt must follow a single-value flag: --remote-control has an optional value.
  args.push("--model", o.model.model);
  if (o.model.effort) args.push("--effort", o.model.effort);
  return args;
}

/**
 * Claude keeps a session's transcript in `<config folder>/projects/<cwd>/<id>.jsonl` (plus an `<id>/`
 * folder for subagents) and `--resume` looks only there, so a session moving to another Account takes
 * them along. Returns whether there was a transcript to copy.
 */
export function copyTranscript(agentSessionId: string, fromDir: string, toDir: string): boolean {
  const projects = join(fromDir, "projects");
  if (!existsSync(projects)) return false;
  let copied = false;
  for (const project of readdirSync(projects)) {
    const file = join(projects, project, `${agentSessionId}.jsonl`);
    if (!existsSync(file)) continue;
    cpSync(file, join(toDir, "projects", project, `${agentSessionId}.jsonl`));
    const sub = join(projects, project, agentSessionId);
    if (existsSync(sub)) cpSync(sub, join(toDir, "projects", project, agentSessionId), { recursive: true });
    copied = true;
  }
  return copied;
}

const settingsPath = (sessionDir: string) => join(sessionDir, "settings.json");

export const claude: Harness = {
  name: "claude",
  label: "Claude Code",
  bin: "claude",
  minVersion: "2.1.0",
  features: {
    launch: { has: true, how: "`--dangerously-skip-permissions`" },
    resume: { has: true, how: "`--resume`" },
    turnEndHook: { has: true, how: "`Stop`" },
    loginCheck: { has: true, how: "`claude auth status`" },
    remoteControl: { has: true, how: "`--remote-control`" },
    nowLine: { has: true, how: "transcript" },
    usageQuota: { has: true, how: "status line" },
    usageLimit: { has: true, how: "`StopFailure`" },
    usageLimitReset: { has: true, how: "transcript" },
    transcriptMove: { has: true, how: "copied" },
  },
  accountEnv: "CLAUDE_CONFIG_DIR",
  defaultAccountFolder: ".claude",
  dialogs: [
    // Answered with Down, Enter: the second option, which is "yes" on both.
    { screen: /Yes, I trust this folder/, keys: ["Down", "Enter"] },
    // REQ-005-01: shown once per Claude config folder before it runs with skipped permissions.
    { screen: /Bypass Permissions mode[\s\S]*Yes, I accept/, keys: ["Down", "Enter"] },
  ],

  /**
   * REQ-005-01: the hooks, the status line (REQ-001-67) and, for REQ-005-07, the CLAUDE.md files above the session's
   * folder to skip; rewritten on every resume, so a session folder from an older Coordinator loses its sandbox.
   */
  writeSessionConfig({ sessionDir, cwd, home, hook }) {
    const hooks = Object.fromEntries(
      CLAUDE_HOOK_EVENTS.map((ev) => [ev, [{ hooks: [{ type: "command", command: hook(ev) }] }]]),
    );
    // REQ-001-67: Claude Code passes the Usage quota only to a status line command.
    const statusLine = { type: "command", command: hook("StatusLine") };
    const claudeMdExcludes = parentInstructionFiles(cwd, home);
    writeFileSync(settingsPath(sessionDir), JSON.stringify({ hooks, statusLine, claudeMdExcludes }, null, 2));
  },

  args: ({ sessionDir, name, model, resumeId }) =>
    claudeArgs({ name, settingsPath: settingsPath(sessionDir), model, resumeId }),

  // REQ-001-62: Claude Code's own temp files; REQ-005-01: it refuses skipped permissions as root without IS_SANDBOX=1.
  env: ({ tmp }) => ({ CLAUDE_CODE_TMPDIR: tmp, IS_SANDBOX: "1" }),

  loginCheck: {
    args: ["auth", "status"],
    read({ out }) {
      try {
        const s = JSON.parse(out) as { loggedIn?: boolean; subscriptionType?: string };
        return s.loggedIn
          ? { ok: true, detail: `${s.subscriptionType ?? "?"} subscription` }
          : { ok: false, detail: "run it and /login" };
      } catch {
        return { ok: false, detail: "could not read `auth status`" };
      }
    },
  },

  moveTranscript: copyTranscript,
};
