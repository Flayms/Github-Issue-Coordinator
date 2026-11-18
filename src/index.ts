/** Coordinator entry point: `bun start` (config from `config.ts` or `$COORDINATOR_CONFIG`). */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { loadDashboardLogin } from "./dashboard/auth.ts";
import { loadDashboardToken, startDashboard } from "./dashboard/server.ts";
import { Clones } from "./git.ts";
import { GitHubClient } from "./github/client.ts";
import { GhToken } from "./github/gh-token.ts";
import { SessionRunner } from "./runner.ts";
import { Store } from "./store.ts";
import { TmuxCli } from "./tmux.ts";
import { Worktrees } from "./worktrees.ts";

export const NAME = "github-issue-coordinator";
const DIALOG_CHECK_MS = 3_000;

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const config = await loadConfig(process.env.COORDINATOR_CONFIG ?? "config.ts");
  const stateDir = resolve(config.stateDir);
  mkdirSync(stateDir, { recursive: true });
  // REQ-003-07: an unusable token stops the start, before anything runs.
  const dashboardToken = loadDashboardToken(config);
  // REQ-003-29: so does an unusable GitHub client secret; the session key is created once in the state dir.
  const dashboardLogin = loadDashboardLogin(config, stateDir);
  // REQ-005-02: the GitHub CLI's PAT; fails the start early if gh isn't logged in.
  const auth = new GhToken();
  await auth.tokenFor("");
  const gh = new GitHubClient({ auth });
  const dbPath = join(stateDir, "state.db");
  const store = new Store(dbPath);
  const runner = new SessionRunner({
    store,
    tmux: new TmuxCli(),
    stateDir,
    dbPath,
    hookCommand: [process.execPath, resolve(import.meta.dir, "hook.ts")],
    accounts: config.accounts,
  });
  const clones = new Clones({ root: join(stateDir, "clones"), token: (repo) => auth.tokenFor(repo) });
  const worktrees = new Worktrees({
    root: stateDir,
    clones,
    token: (repo) => auth.tokenFor(repo),
    setup: (repo) => config.repos.find((r) => r.name.toLowerCase() === repo.toLowerCase())?.setup,
    maxWorktrees: config.limits.maxWorktrees,
    commitAuthor: config.github.commitAuthor,
  });
  const coordinator = new Coordinator({ config, store, gh, runner, clones, worktrees, log });

  for (const { name } of config.repos) {
    try {
      await gh.ensureAgentLabels(name);
    } catch (e) {
      log(`${name}: could not create agent labels: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // REQ-003-08: it serves the last tick's snapshot and fails on its own.
  const dashboard = startDashboard({
    config,
    token: dashboardToken,
    login: dashboardLogin,
    snapshot: () => coordinator.snapshot(),
    timings: store,
    log,
  });
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
  dashboard?.stop();
  store.close();
}

if (import.meta.main) await main();
