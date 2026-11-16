import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySessionRunning, TmuxCli, tmuxSocketPath } from "../src/tmux.ts";

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

  test("REQ-001-58 sees Coordinator sessions left on tmux's default socket by an older Coordinator", () => {
    const { calls, exec } = recording();
    expect(legacySessionRunning(exec)).toBe(true);
    expect(calls).toEqual([["tmux", "has-session", "-t", "coordinator"]]);
    expect(legacySessionRunning(() => ({ ok: false, out: "", err: "no server running" }))).toBe(false);
  });
});
