import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPathOf, defaultStateDir } from "../src/paths.ts";

describe("locations", () => {
  test("REQ-007-02 the config is in $XDG_CONFIG_HOME, else ~/.config; --config and $COORDINATOR_CONFIG override it", () => {
    expect(configPathOf(undefined, {})).toBe(join(homedir(), ".config", "github-issue-coordinator", "config.json"));
    expect(configPathOf(undefined, { XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/github-issue-coordinator/config.json");
    expect(configPathOf(undefined, { XDG_CONFIG_HOME: "relative" })).toBe(
      join(homedir(), ".config", "github-issue-coordinator", "config.json"),
    );
    expect(configPathOf(undefined, { COORDINATOR_CONFIG: "/etc/c.json", XDG_CONFIG_HOME: "/cfg" })).toBe("/etc/c.json");
    expect(configPathOf("/flag.json", { COORDINATOR_CONFIG: "/etc/c.json" })).toBe("/flag.json");
    // A relative path is the working folder's, resolved once, so later reads don't depend on it.
    expect(configPathOf("c.json", {})).toBe(join(process.cwd(), "c.json"));
  });

  test("REQ-007-03 state is in $XDG_DATA_HOME, else ~/.local/share", () => {
    expect(defaultStateDir({})).toBe(join(homedir(), ".local", "share", "github-issue-coordinator"));
    expect(defaultStateDir({ XDG_DATA_HOME: "/data" })).toBe("/data/github-issue-coordinator");
  });
});
