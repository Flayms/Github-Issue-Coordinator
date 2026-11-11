/** Coordinator entry point: `bun start` (config from `config.ts` or `$COORDINATOR_CONFIG`). */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { Clones } from "./git.ts";
import { AppAuth } from "./github/app-auth.ts";
import { GitHubClient } from "./github/client.ts";
import { SessionRunner } from "./runner.ts";
import { Store } from "./store.ts";
import { TmuxCli } from "./tmux.ts";

export const NAME = "github-issue-coordinator";
const DIALOG_CHECK_MS = 3_000;

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const config = await loadConfig(process.env.COORDINATOR_CONFIG ?? "config.ts");
  const stateDir = resolve(config.stateDir);
  mkdirSync(stateDir, { recursive: true });
  let privateKey: string;
  try {
    privateKey = readFileSync(config.github.privateKeyPath, "utf8");
  } catch {
    throw new Error(
      `cannot read the GitHub App private key at ${config.github.privateKeyPath} (github.privateKeyPath)`,
    );
  }
  const auth = new AppAuth({ appId: config.github.appId, privateKey });
  const gh = new GitHubClient({ auth });
  const dbPath = join(stateDir, "state.db");
  const store = new Store(dbPath);
  const runner = new SessionRunner({
    store,
    tmux: new TmuxCli(),
    stateDir,
    dbPath,
    hookCommand: [process.execPath, resolve(import.meta.dir, "hook.ts")],
  });
  const clones = new Clones({ root: join(stateDir, "clones"), token: (repo) => auth.tokenFor(repo) });
  const coordinator = new Coordinator({ config, store, gh, runner, clones, log });

  for (const { name } of config.repos) {
    try {
      await gh.ensureAgentLabels(name);
    } catch (e) {
      log(`${name}: could not create agent labels: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`${NAME}: watching ${config.repos.map((r) => r.name).join(", ")} every ${config.pollIntervalSec}s`);

  let stopping = false;
  const stop = () => {
    stopping = true;
    log("stopping; agent sessions keep running in tmux and are picked up on the next start");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const dialogs = setInterval(() => runner.answerDialogs(), DIALOG_CHECK_MS);
  while (!stopping) {
    await coordinator.tick();
    for (let waited = 0; waited < config.pollIntervalSec * 1000 && !stopping; waited += 500) await Bun.sleep(500);
  }
  clearInterval(dialogs);
  store.close();
}

if (import.meta.main) await main();
