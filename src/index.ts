/** The Coordinator itself: `coordinator start` (REQ-007-01), with the config file from `src/cli.ts`. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigFile } from "./config-file.ts";
import { Coordinator } from "./coordinator.ts";
import { loadDashboardLogin } from "./dashboard/auth.ts";
import { loadDashboardToken, startDashboard } from "./dashboard/server.ts";
import { Clones } from "./git.ts";
import { GitHubClient } from "./github/client.ts";
import { GhToken } from "./github/gh-token.ts";
import { SessionRunner } from "./runner.ts";
import { Store } from "./store.ts";
import { TmuxCli } from "./tmux.ts";
import { VERSION } from "./version.ts";
import { Worktrees } from "./worktrees.ts";

export const NAME = "github-issue-coordinator";
const DIALOG_CHECK_MS = 3_000;
/** How often the config file is read for hand edits while waiting for the next tick (REQ-007-06). */
const RELOAD_EVERY_MS = 5_000;

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

export async function start(configPath: string) {
  // REQ-007-05 / REQ-007-06: `live.current` changes when the Owner saves settings or edits the file.
  const live = new ConfigFile(configPath, { log });
  // REQ-007-07: settings that need a restart are read from `config`, the startup config; the rest from `live.current`.
  const config = live.startup;
  const stateDir = config.stateDir;
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
    maxWorktrees: () => live.current.limits.maxWorktrees,
    commitAuthor: config.github.commitAuthor,
  });
  const coordinator = new Coordinator({
    get config() {
      return live.current;
    },
    store,
    gh,
    runner,
    clones,
    worktrees,
    log,
  });

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
    settings: live,
    version: VERSION,
    token: dashboardToken,
    login: dashboardLogin,
    snapshot: () => coordinator.snapshot(),
    reportedModels: () => store.reportedModelIds(),
    timings: store,
    log,
  });
  log(`${NAME} ${VERSION}: config ${configPath}, state in ${stateDir}`);
  log(`${NAME}: watching ${config.repos.map((r) => r.name).join(", ")} every ${live.current.pollIntervalSec}s`);

  let stopping = false;
  const stop = () => {
    stopping = true;
    log("stopping; agent sessions keep running in tmux and are picked up on the next start");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const dialogs = setInterval(() => {
    runner.answerDialogs();
    // REQ-006-04: e.g. Codex ends a turn on the usage limit without a Stop hook.
    for (const id of runner.detectEndedTurns()) log(`session ${id}: the turn ended on the usage limit`);
  }, DIALOG_CHECK_MS);
  while (!stopping) {
    // REQ-007-06: a hand edit of the config file applies from this tick on.
    live.reload();
    await coordinator.tick();
    // The poll interval is read while waiting, so a saved one applies to the wait in progress (REQ-007-05).
    // REQ-007-06: the file is also read while waiting, so the dashboard and a shorter interval see a hand edit soon.
    for (let waited = 0; waited < live.current.pollIntervalSec * 1000 && !stopping; waited += 500) {
      await Bun.sleep(500);
      if (waited % RELOAD_EVERY_MS === 0) live.reload();
    }
  }
  clearInterval(dialogs);
  dashboard?.stop();
  store.close();
}

// The unit before spec 007 ran `bun src/index.ts` with a `config.ts`: say what to do instead of exiting quietly.
if (import.meta.main) {
  console.error(
    "src/index.ts is no longer run directly: run `coordinator init` (writes config.json), then `coordinator service install`; from a checkout `bun src/cli.ts start --config <config.json>` (docs/setup.md)",
  );
  process.exit(1);
}
