#!/usr/bin/env bun
/**
 * The `issueflow` command (REQ-007-01): the package's `bin`, or `bun src/cli.ts` in a checkout. Each command loads
 * its own modules, so `--version` and `--help` stay quick.
 */
import { configPathOf } from "./paths.ts";
import { VERSION } from "./version.ts";

export const SERVICE_COMMANDS = ["install", "uninstall", "status", "logs", "restart"] as const;
export type ServiceCommand = (typeof SERVICE_COMMANDS)[number];

/** What each command does; each returns the exit code, `start` runs until it is stopped. */
export interface Commands {
  start(configPath: string): Promise<void>;
  doctor(configPath: string): Promise<number>;
  init(configPath: string): Promise<number>;
  service(command: ServiceCommand, configPath: string): Promise<number>;
}

const COMMANDS: Commands = {
  start: async (path) => (await import("./index.ts")).start(path),
  doctor: async (path) => ((await (await import("./doctor.ts")).doctor(path)) ? 1 : 0),
  init: async (path) => (await import("./init/run.ts")).runInit(path),
  service: async (command, path) => (await import("./service.ts")).service(command, path),
};

export const USAGE = `Usage: issueflow <command> [--config <path>]

Commands:
  init                 Set up: asks a few questions, writes the config, installs the service
  start                Run the Coordinator
  doctor               Check the setup
  service install      Install and start the systemd service
  service uninstall    Stop and remove the systemd service
  service status       Show the service's status
  service logs         Follow the service's log
  service restart      Restart the service, e.g. after an update

Options:
  --config <path>      The config file (default: $ISSUEFLOW_CONFIG, else
                       ~/.config/issueflow/config.json)
  --version            Print the version
  --help               Print this help`;

type Env = Record<string, string | undefined>;

/** Runs the command line `argv` (without `bun` and the script); returns the exit code. */
export async function main(
  argv: string[],
  opts: { commands?: Commands; print?: (line: string) => void; env?: Env } = {},
): Promise<number> {
  const { commands = COMMANDS, print = console.log, env = process.env } = opts;
  const usage = () => {
    print(USAGE);
    return 2;
  };
  let config: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--config") {
      const next = argv[++i];
      if (next === undefined) return usage();
      config = next;
    } else if (a.startsWith("--config=")) config = a.slice("--config=".length);
    else if (a === "--version" || a === "-v") {
      print(VERSION);
      return 0;
    } else if (a === "--help" || a === "-h") {
      print(USAGE);
      return 0;
    } else rest.push(a);
  }
  const path = configPathOf(config, env);
  const [command, sub, ...extra] = rest;
  if (command === "service" && SERVICE_COMMANDS.includes(sub as ServiceCommand) && !extra.length)
    return commands.service(sub as ServiceCommand, path);
  if (sub !== undefined) return usage();
  if (command === "start") {
    await commands.start(path);
    return 0;
  }
  if (command === "doctor") return commands.doctor(path);
  if (command === "init") return commands.init(path);
  return usage();
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
