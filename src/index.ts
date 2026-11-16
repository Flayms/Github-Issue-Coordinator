/** Coordinator entry point: `bun start` (config from `config.ts` or `$COORDINATOR_CONFIG`). */
import { mkdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, secretPaths } from "./config.ts";
import { Coordinator } from "./coordinator.ts";
import { loadDashboardToken, startDashboard } from "./dashboard/server.ts";
import { Clones } from "./git.ts";
import { AppAuth } from "./github/app-auth.ts";
import { GitHubClient } from "./github/client.ts";
import { ReadTokens } from "./github/read-tokens.ts";
import { hostControlSockets, SessionRunner } from "./runner.ts";
import { Store } from "./store.ts";
import { legacyAgentWindows, TmuxCli, tmuxSocketPath } from "./tmux.ts";
import { Worktrees } from "./worktrees.ts";

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
  // REQ-003-07: an unusable token stops the start, before anything runs.
  const dashboardToken = loadDashboardToken(config);
  const auth = new AppAuth({ appId: config.github.appId, privateKey });
  const gh = new GitHubClient({ auth });
  // REQ-001-55: agents read GitHub with a read-only token of the same installation.
  const readTokens = new ReadTokens((repo) => auth.readTokenFor(repo), log);
  // REQ-001-58: agents on tmux's default socket are invisible to the fixed socket and would be resumed twice.
  const legacy = legacyAgentWindows();
  if (legacy.length)
    throw new Error(
      `agent sessions ${legacy.join(", ")} still run in the tmux session 'coordinator' on tmux's default socket ` +
        "(started before the Coordinator used its own socket); let them finish or end them with " +
        "`tmux kill-session -t coordinator`, then start again (docs/setup.md)",
    );
  const tmuxSocket = tmuxSocketPath(stateDir);
  const dbPath = join(stateDir, "state.db");
  const store = new Store(dbPath);
  const runner = new SessionRunner({
    store,
    tmux: new TmuxCli({ socket: tmuxSocket }),
    stateDir,
    dbPath,
    hookCommand: [process.execPath, resolve(import.meta.dir, "hook.ts")],
    // REQ-001-26 / REQ-004-02: the App key's folder and every Account's Claude login.
    secretPaths: secretPaths(config, homedir()),
    // REQ-001-58: hidden from Implementers, whose sandbox may open Unix sockets (REQ-001-53).
    controlSockets: hostControlSockets(tmuxSocket, process.getuid?.() ?? userInfo().uid),
    accounts: config.accounts,
    readToken: (repo) => readTokens.get(repo),
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
  const dashboard = startDashboard({ config, token: dashboardToken, snapshot: () => coordinator.snapshot(), log });
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
    // REQ-001-55: tokens expire after an hour; renewed before sessions start and for those already running.
    await readTokens.refresh(config.repos.map((r) => r.name));
    runner.refreshGitHubAccess();
    await coordinator.tick();
    for (let waited = 0; waited < config.pollIntervalSec * 1000 && !stopping; waited += 500) await Bun.sleep(500);
  }
  clearInterval(dialogs);
  dashboard?.stop();
  store.close();
}

if (import.meta.main) await main();
