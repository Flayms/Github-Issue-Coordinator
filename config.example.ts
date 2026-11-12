// Copy to `config.ts` (gitignored) and fill in. Validated on startup by src/config.ts.
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  // The Owner: the only human whose issues, comments, labels and reviews count (REQ-001-01).
  // Numeric id: `gh api users/<login> --jq .id`
  owner: { login: "your-login", id: 0 },
  // The Coordinator's GitHub App (REQ-001-15). Keep the private key outside this repo.
  github: { appId: 0, privateKeyPath: "/home/agent/.config/coordinator/app.pem" },
  pollIntervalSec: 60,
  stateDir: "state", // store, session files and clones (outside the managed repos)
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
  // sandboxDomains: what the Implementer's shell commands may reach (default: npm and PyPI registries).
  repos: [{ name: "your-login/your-repo", setup: "bun install", roles: { reviewer: { model: "sonnet" } } }],
});
