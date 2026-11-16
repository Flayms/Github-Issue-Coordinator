import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyAgentWindows, TmuxCli, tmuxSocketPath } from "../src/tmux.ts";

/** Records every tmux call instead of running it; every call succeeds. */
function recording() {
  const calls: string[][] = [];
  const exec = (cmd: string[]) => {
    calls.push(cmd);
    return { ok: true, out: "", err: "" };
  };
  return { calls, exec };
}

describe("tmux", () => {
  test("REQ-001-58 every tmux call goes to the Coordinator's own socket, whose folder is created private", () => {
    const state = mkdtempSync(join(tmpdir(), "tmux-"));
    try {
      const socket = tmuxSocketPath(state);
      expect(socket).toBe(join(state, "tmux", "coordinator.sock"));
      const { calls, exec } = recording();
      const t = new TmuxCli({ socket, exec });
      t.listWindows();
      t.newWindow("s1", "/w", "claude");
      t.capture("s1");
      t.sendKeys("s1", "Enter");
      t.killWindow("s1");
      expect(calls.length).toBeGreaterThanOrEqual(5);
      for (const c of calls) expect(c.slice(0, 3)).toEqual(["tmux", "-S", socket]);
      expect(statSync(join(state, "tmux")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(state, { recursive: true });
    }
  });

  test("REQ-001-58 sessions live in the tmux session named at construction", () => {
    const { calls, exec } = recording();
    new TmuxCli({ socket: join(tmpdir(), "x", "s.sock"), session: "coordinator-smoke", exec }).killWindow("s1");
    expect(calls[0]).toContain("coordinator-smoke:=s1");
  });

  describe("REQ-001-58 the tmux session an older Coordinator left on tmux's default socket", () => {
    /** Answers `list-windows` with the given windows (none: no server), records every call. */
    const legacy = (windows: string[] | null) => {
      const calls: string[][] = [];
      const exec = (cmd: string[]) => {
        calls.push(cmd);
        if (cmd[1] === "list-windows")
          return windows ? { ok: true, out: windows.join("\n"), err: "" } : { ok: false, out: "", err: "no server" };
        return { ok: true, out: "", err: "" };
      };
      return { calls, exec };
    };

    test("names its agent windows, ignoring keepalive, and leaves it alone", () => {
      const { calls, exec } = legacy(["keepalive", "s12", "s14"]);
      expect(legacyAgentWindows(exec)).toEqual(["s12", "s14"]);
      expect(calls).toEqual([["tmux", "list-windows", "-t", "coordinator", "-F", "#{window_name}"]]);
    });

    test("with only keepalive left, ends that session so the Coordinator can start", () => {
      const { calls, exec } = legacy(["keepalive"]);
      expect(legacyAgentWindows(exec)).toEqual([]);
      expect(calls[1]).toEqual(["tmux", "kill-session", "-t", "coordinator"]);
    });

    test("without that session there is nothing to do", () => {
      const { calls, exec } = legacy(null);
      expect(legacyAgentWindows(exec)).toEqual([]);
      expect(calls).toHaveLength(1);
    });
  });
});
