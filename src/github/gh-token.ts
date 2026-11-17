/**
 * REQ-005-02: the only GitHub credential on the VM is the fine-grained PAT the GitHub CLI is logged in with
 * (`gh auth login`, or `GH_TOKEN`). The Coordinator reads it from `gh auth token`; agents use `gh` directly.
 */

type Run = (cmd: string[]) => { ok: boolean; out: string };

/** How long a token read from gh is used before gh is asked again, so a changed token needs no restart. */
const TTL_MS = 5 * 60_000;

const spawn: Run = (cmd) => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { ok: p.exitCode === 0, out: p.exitCode === 0 ? p.stdout.toString() : p.stderr.toString() };
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
};

export class GhToken {
  private cached?: { token: string; at: number };

  constructor(private readonly o: { run?: Run; now?: () => number } = {}) {}

  /** The token for any repository: one PAT covers every managed repository. */
  async tokenFor(_repo: string): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    if (this.cached && now - this.cached.at < TTL_MS) return this.cached.token;
    const r = (this.o.run ?? spawn)(["gh", "auth", "token"]);
    const token = r.out.trim();
    if (!r.ok || !token)
      throw new Error(
        `no GitHub token: log in with \`gh auth login\` (a fine-grained PAT) or set GH_TOKEN${r.ok ? "" : ` (${token})`}`,
      );
    this.cached = { token, at: now };
    return token;
  }
}
