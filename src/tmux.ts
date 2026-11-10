/** The tmux operations the session runner needs; `TmuxCli` drives the real tmux. */
export interface Tmux {
  listWindows(): string[];
  /** Starts `command` (a shell command line) in a new detached window. */
  newWindow(name: string, cwd: string, command: string): void;
  killWindow(name: string): void;
  capture(name: string): string;
  sendKeys(name: string, ...keys: string[]): void;
}

export class TmuxCli implements Tmux {
  /** All Coordinator windows live in one tmux session, which the Owner never needs to touch. */
  constructor(private readonly session = "coordinator") {}

  listWindows(): string[] {
    const r = run(["tmux", "list-windows", "-t", this.session, "-F", "#{window_name}"]);
    return r.ok ? r.out.split("\n").filter(Boolean) : [];
  }

  newWindow(name: string, cwd: string, command: string): void {
    if (!run(["tmux", "has-session", "-t", this.session]).ok) {
      // The first window keeps the tmux session alive while no agent runs.
      must(["tmux", "new-session", "-d", "-s", this.session, "-n", "keepalive", "-x", "200", "-y", "50"]);
    }
    must(["tmux", "new-window", "-d", "-t", `${this.session}:`, "-n", name, "-c", cwd, command]);
  }

  killWindow(name: string): void {
    run(["tmux", "kill-window", "-t", this.target(name)]);
  }

  capture(name: string): string {
    return run(["tmux", "capture-pane", "-p", "-t", this.target(name)]).out;
  }

  sendKeys(name: string, ...keys: string[]): void {
    run(["tmux", "send-keys", "-t", this.target(name), ...keys]);
  }

  private target(name: string): string {
    return `${this.session}:=${name}`;
  }
}

function run(cmd: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function must(cmd: string[]): void {
  const r = run(cmd);
  if (!r.ok) throw new Error(`${cmd.slice(0, 2).join(" ")} failed: ${r.err}`);
}
