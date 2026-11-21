/**
 * `coordinator service` (REQ-007-11): the systemd unit, made from the machine it is installed on, and the systemctl
 * and journalctl calls around it.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ServiceCommand } from "./cli.ts";
import { APP_NAME } from "./paths.ts";

export const SERVICE_NAME = APP_NAME;
export const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

const SYSTEM_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

export interface UnitInput {
  bun: string;
  /** Absent when `claude` isn't on PATH; its usual folder is on the unit's PATH anyway. */
  claude?: string;
  /** The package's `src/cli.ts`. */
  entry: string;
  configPath: string;
  user: string;
  home: string;
}

/** A systemd value: quoted when it has whitespace or quotes. */
const quote = (v: string) => (/[\s"\\]/.test(v) ? `"${v.replace(/["\\]/g, "\\$&")}"` : v);

/** REQ-007-11: the unit text. */
export function serviceUnit(u: UnitInput): string {
  const path = [
    ...new Set([
      dirname(u.bun),
      ...(u.claude ? [dirname(u.claude)] : []),
      join(u.home, ".local", "bin"),
      join(u.home, ".bun", "bin"),
      ...SYSTEM_PATH,
    ]),
  ].join(":");
  return `# Made by \`coordinator service install\` (docs/setup.md step 5); run it again after moving bun or the config.
[Unit]
Description=GitHub Issue Coordinator (agents for GitHub issues)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${u.user}
WorkingDirectory=${quote(u.home)}
# claude (~/.local/bin) and bun (~/.bun/bin) are installed per user.
Environment=${quote(`PATH=${path}`)}
Environment=${quote(`COORDINATOR_CONFIG=${u.configPath}`)}
ExecStart=${[u.bun, u.entry, "start", "--config", u.configPath].map(quote).join(" ")}
Restart=on-failure
RestartSec=30
# Agent sessions live in a tmux server started by the Coordinator. Only stop the Coordinator itself on a stop or
# restart; the sessions keep running and are picked up again on the next start.
KillMode=process

[Install]
WantedBy=multi-user.target
`;
}

/** The machine, so tests run without systemd or root. */
export interface ServiceEnv {
  which(bin: string): string | undefined;
  home: string;
  user: string;
  /** The package's `src/cli.ts`. */
  entry: string;
  exists(path: string): boolean;
  /** Runs a command with the terminal attached; returns its exit code. */
  run(cmd: string[]): number;
  writeFile(path: string, text: string): void;
  removeFile(path: string): void;
  print(line: string): void;
}

export const machine = (): ServiceEnv => ({
  which: (bin) => Bun.which(bin) ?? undefined,
  home: homedir(),
  user: userInfo().username,
  entry: resolve(import.meta.dir, "cli.ts"),
  exists: existsSync,
  run: (cmd) => Bun.spawnSync(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exitCode,
  writeFile: (path, text) => writeFileSync(path, text),
  removeFile: (path) => rmSync(path, { force: true }),
  print: console.log,
});

/** Runs `coordinator service <command>`; returns the exit code. */
export async function service(command: ServiceCommand, configPath: string, env = machine()): Promise<number> {
  /** Runs each command in turn; stops at the first that fails. */
  const steps = (...cmds: string[][]) => {
    for (const cmd of cmds) {
      const code = env.run(cmd);
      if (code !== 0) {
        env.print(`${cmd.join(" ")} failed (exit code ${code})`);
        return 1;
      }
    }
    return 0;
  };
  switch (command) {
    case "install":
      return install(configPath, env, steps);
    case "uninstall": {
      // Stopped first; a unit that isn't loaded is fine to remove.
      env.run(["systemctl", "disable", "--now", SERVICE_NAME]);
      env.removeFile(UNIT_PATH);
      const code = steps(["systemctl", "daemon-reload"]);
      if (!code) env.print(`removed ${UNIT_PATH}; agent sessions still running in tmux keep going`);
      return code;
    }
    case "status":
      return env.run(["systemctl", "status", SERVICE_NAME, "--no-pager"]);
    case "logs":
      return env.run(["journalctl", "-u", SERVICE_NAME, "-f", "-n", "100"]);
    case "restart":
      return steps(["systemctl", "restart", SERVICE_NAME]);
  }
}

function install(configPath: string, env: ServiceEnv, steps: (...cmds: string[][]) => number): number {
  if (!env.exists(configPath)) {
    env.print(`no config at ${configPath}: run \`coordinator init\` first`);
    return 1;
  }
  const bun = env.which("bun");
  if (!bun) {
    env.print("bun is not on PATH");
    return 1;
  }
  const unit = serviceUnit({
    bun,
    claude: env.which("claude"),
    entry: env.entry,
    configPath,
    user: env.user,
    home: env.home,
  });
  try {
    env.writeFile(UNIT_PATH, unit);
  } catch (e) {
    const denied = (e as NodeJS.ErrnoException).code === "EACCES";
    env.print(
      `could not write ${UNIT_PATH}: ${e instanceof Error ? e.message : String(e)}${denied ? " (run it as root: sudo coordinator service install)" : ""}`,
    );
    return 1;
  }
  const code = steps(["systemctl", "daemon-reload"], ["systemctl", "enable", "--now", SERVICE_NAME]);
  if (!code)
    env.print(
      `installed and started ${SERVICE_NAME} (${UNIT_PATH}); follow it with \`coordinator service logs\`, update with \`bun add -g ${APP_NAME}@latest && coordinator service restart\``,
    );
  return code;
}
