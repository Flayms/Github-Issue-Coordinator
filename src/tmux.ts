import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The tmux operations the session runner needs; `TmuxCli` drives the real tmux. */
export interface Tmux {
  listWindows(): string[];
  /** Starts `command` (a shell command line) in a new detached window. */
  newWindow(name: string, cwd: string, command: string): void;
  killWindow(name: string): void;
  capture(name: string): string;
  sendKeys(name: string, ...keys: string[]): void;
}

type Exec = (cmd: string[]) => { ok: boolean; out: string; err: string };

/**
 * REQ-001-58: the Coordinator's tmux server listens on a fixed socket in its state folder, not tmux's default
 * under `/tmp` or `$TMUX_TMPDIR`, so an Implementer's sandbox can hide that folder.
 */
export const tmuxSocketPath = (stateDir: string): string => join(stateDir, "tmux", "coordinator.sock");

export class TmuxCli implements Tmux {
  private readonly socket: string;
  /** All Coordinator windows live in one tmux session, which the Owner never needs to touch. */
  private readonly session: string;
  private readonly exec: Exec;

  constructor(o: { socket: string; session?: string; exec?: Exec }) {
    this.socket = o.socket;
    this.session = o.session ?? "coordinator";
    this.exec = o.exec ?? run;
    mkdirSync(dirname(this.socket), { recursive: true, mode: 0o700 });
  }

  listWindows(): string[] {
    const r = this.tmux("list-windows", "-t", this.session, "-F", "#{window_name}");
    return r.ok ? r.out.split("\n").filter(Boolean) : [];
  }

  newWindow(name: string, cwd: string, command: string): void {
    if (!this.tmux("has-session", "-t", this.session).ok) {
      // The first window keeps the tmux session alive while no agent runs.
      this.must("new-session", "-d", "-s", this.session, "-n", "keepalive", "-x", "200", "-y", "50");
    }
    this.must("new-window", "-d", "-t", `${this.session}:`, "-n", name, "-c", cwd, command);
  }

  killWindow(name: string): void {
    this.tmux("kill-window", "-t", this.target(name));
  }

  capture(name: string): string {
    return this.tmux("capture-pane", "-p", "-t", this.target(name)).out;
  }

  sendKeys(name: string, ...keys: string[]): void {
    this.tmux("send-keys", "-t", this.target(name), ...keys);
  }

  private target(name: string): string {
    return `${this.session}:=${name}`;
  }

  private tmux(...args: string[]) {
    return this.exec(["tmux", "-S", this.socket, ...args]);
  }

  private must(...args: string[]): void {
    const r = this.tmux(...args);
    if (!r.ok) throw new Error(`tmux ${args[0]} failed: ${r.err}`);
  }
}

/**
 * REQ-001-58: whether Coordinator sessions still run on tmux's default socket, where Coordinators before the fixed
 * socket started them. A new Coordinator wouldn't see them and would resume them a second time.
 */
export function legacySessionRunning(exec: Exec = run, session = "coordinator"): boolean {
  return exec(["tmux", "has-session", "-t", session]).ok;
}

function run(cmd: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
