import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Commands, main } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

/** Commands that record how they were called and return `code`. */
const recorder = (code = 0) => {
  const calls: unknown[][] = [];
  const commands: Commands = {
    start: async (path) => {
      calls.push(["start", path]);
    },
    doctor: async (path) => {
      calls.push(["doctor", path]);
      return code;
    },
    init: async (path) => {
      calls.push(["init", path]);
      return code;
    },
    service: async (sub, path) => {
      calls.push(["service", sub, path]);
      return code;
    },
  };
  return { calls, commands };
};

const runCli = async (argv: string[], env: Record<string, string | undefined> = {}, code = 0) => {
  const r = recorder(code);
  const out: string[] = [];
  const exit = await main(argv, { commands: r.commands, print: (l) => out.push(l), env });
  return { exit, calls: r.calls, out: out.join("\n") };
};

const DEFAULT = join("/cfg", "issueflow", "config.json");

describe("issueflow command", () => {
  test("REQ-007-01 each command gets the config path: --config before or after it, else $ISSUEFLOW_CONFIG, else the default", async () => {
    const env = { XDG_CONFIG_HOME: "/cfg" };
    expect((await runCli(["start"], env)).calls).toEqual([["start", DEFAULT]]);
    expect((await runCli(["doctor", "--config", "/a.json"], env)).calls).toEqual([["doctor", "/a.json"]]);
    expect((await runCli(["--config=/b.json", "init"], env)).calls).toEqual([["init", "/b.json"]]);
    expect((await runCli(["service", "install"], { ...env, ISSUEFLOW_CONFIG: "/c.json" })).calls).toEqual([
      ["service", "install", "/c.json"],
    ]);
    for (const sub of ["uninstall", "status", "logs", "restart"])
      expect((await runCli(["service", sub], env)).calls).toEqual([["service", sub, DEFAULT]]);
  });

  test("REQ-007-01 a command's result is the exit code", async () => {
    expect((await runCli(["doctor"], {}, 2)).exit).toBe(2);
    expect((await runCli(["start"])).exit).toBe(0);
  });

  test("REQ-007-01 / REQ-007-12 --version prints the version; --help, no command or an unknown one print the usage", async () => {
    expect(await runCli(["--version"])).toEqual({ exit: 0, calls: [], out: VERSION });
    const help = await runCli(["--help"]);
    expect(help.exit).toBe(0);
    expect(help.out).toContain("Usage: issueflow <command>");
    for (const cmd of ["init", "start", "doctor", "service install", "--config <path>"])
      expect(help.out).toContain(cmd);
    for (const argv of [[], ["frobnicate"], ["service"], ["service", "explode"], ["start", "--config"]]) {
      const r = await runCli(argv);
      expect(r.exit).toBe(2);
      expect(r.calls).toEqual([]);
      expect(r.out).toContain("Usage: issueflow <command>");
    }
  });
});
