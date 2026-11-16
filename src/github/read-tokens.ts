/**
 * REQ-001-55: the current read-only GitHub token per repository, for agent sessions. Refreshed
 * asynchronously before each tick, so the (synchronous) session runner can hand it out.
 */
export class ReadTokens {
  private readonly tokens = new Map<string, string>();

  constructor(
    private readonly mint: (repo: string) => Promise<string>,
    private readonly log: (message: string) => void,
  ) {}

  /** Renews the tokens of these repositories; one that fails is left out (its sessions read only public data). */
  async refresh(repos: string[]): Promise<void> {
    for (const repo of repos) {
      const key = repo.toLowerCase();
      try {
        this.tokens.set(key, await this.mint(key));
      } catch (e) {
        this.tokens.delete(key);
        this.log(`${key}: no read-only GitHub token for agents: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  get(repo: string): string | undefined {
    return this.tokens.get(repo.toLowerCase());
  }
}
