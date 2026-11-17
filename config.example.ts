// Copy to `config.ts` (gitignored) and fill in. Validated on startup by src/config.ts.
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  // The Owner: the only human whose issues, comments, labels and reviews count (REQ-001-01).
  // Numeric id: `gh api users/<login> --jq .id`
  owner: { login: "your-login", id: 0 },
  // GitHub access is the GitHub CLI's login, a fine-grained PAT (`gh auth login`, docs/setup.md step 1); nothing here.
  // github: { commitAuthor: { name: "Claude", email: "noreply@anthropic.com" } }, // author of the Implementer's commits
  pollIntervalSec: 60,
  // A PR head without check runs is reviewed only this long after it appeared, so CI can register first.
  checksGraceSeconds: 120,
  stateDir: ".coordinator", // store, session files, clones and Worktrees (outside the managed repos)
  // All optional; these are the defaults. maxLiveSessions counts running and idle sessions.
  limits: {
    maxRunning: 1,
    maxPlanners: 1,
    maxImplementers: 1,
    maxReviewers: 1,
    maxLiveSessions: 2,
    idleTimeoutMin: 30,
    maxWorktrees: 5,
    maxFeedbackRounds: 2,
  },
  // Model and optional effort (low | medium | high | xhigh | max) per Role (REQ-001-22).
  roles: {
    planner: { model: "opus", effort: "high" },
    implementer: { model: "sonnet" },
    reviewer: { model: "opus" },
  },
  repos: [{ name: "your-login/your-repo", setup: "bun install", roles: { reviewer: { model: "sonnet" } } }],
  // Claude subscriptions in priority order (optional; default: the login in ~/.claude). Sessions run on the first one
  // that isn't paused by a usage limit. Log in to each once: CLAUDE_CONFIG_DIR=<configDir> claude, then /login.
  // accounts: [{ name: "main" }, { name: "spare", configDir: "/root/.claude-spare" }],
  // Read-only dashboard (docs/setup.md step 4), on by default at 127.0.0.1:8080 without a token; `dashboard: false` turns it off.
  // Any host other than loopback needs a tokenPath.
  // dashboard: { port: 8080, tokenPath: "/root/.config/coordinator/dashboard-token" },
});
