/** Coordinator entry point. The reconcile loop is wired up in later tasks (plan.md T3–T13). */
import { loadConfig } from "./config.ts";

export const NAME = "github-issue-coordinator";

if (import.meta.main) {
  const config = await loadConfig(process.env.COORDINATOR_CONFIG ?? "config.ts");
  console.log(`${NAME}: config ok, ${config.repos.length} repositories`);
}
