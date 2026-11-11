/** The note every comment, PR and review by the Coordinator starts with (AGENTS.md). */
export const agentNote = (model: string, owner: string): string =>
  `> [!Note]\n> 🤖 Claude (${model}) writing on behalf of ${owner}`;
