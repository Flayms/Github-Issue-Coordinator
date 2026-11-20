// Copy to `config.ts` (gitignored) and fill in. Validated on startup by src/config.ts.
import { defineConfig } from "./src/config.ts";

export default defineConfig({
  // The Owner: the only human whose issues, comments, labels and reviews count (REQ-001-01).
  // Numeric id: `gh api users/<login> --jq .id`
  owner: { login: "your-login", id: 0 },
  // GitHub access is the GitHub CLI's login, a fine-grained PAT (`gh auth login`, docs/setup.md step 1); nothing here.
  // github: { commitAuthor: { name: "Claude", email: "noreply@anthropic.com" } }, // author of the Implementer's commits
  pollIntervalSec: 60,
  // A reviewed PR head without check runs leaves draft only this long after it appeared, so CI can register first.
  checksGraceSeconds: 120,
  stateDir: ".coordinator", // store, session files, clones and Worktrees (outside the managed repos)
  // What the Coordinator merges itself once a PR passed its Review and checks: "evaluated" (default: PRs the Reviewer
  // rated low risk), "off" (you merge everything) or "all". A repository can set its own `autoMerge`.
  // Also editable on the dashboard's Config page.
  autoMerge: "evaluated",
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
  // Model and optional effort (low | medium | high | xhigh | max) per Role (REQ-001-22). Any `claude --model` value:
  // an alias (opus, sonnet, haiku, fable) or a model id (claude-opus-5-5). The Config page offers the Model catalogue
  // of src/models.ts and keeps a value from here that isn't in it (REQ-003-40).
  roles: {
    planner: { model: "opus", effort: "high" },
    implementer: { model: "sonnet" },
    reviewer: { model: "opus" },
  },
  // Extra instructions per Role, added after its prompt (REQ-002-17); a repository's come after these. Also editable
  // on the Config page. At most 4,000 characters each.
  // instructions: { planner: "Keep Assessments short." },
  repos: [{ name: "your-login/your-repo", setup: "bun install", roles: { reviewer: { model: "sonnet" } } }],
  // Subscriptions in priority order (optional; default: the Claude Code login in ~/.claude). Sessions run on the first
  // one of their model's Harness that isn't paused by a usage limit (docs/harnesses.md). Log in to each once:
  // CLAUDE_CONFIG_DIR=<configDir> claude, then /login; for Codex CLI, CODEX_HOME=<configDir> codex login; for Copilot
  // CLI, COPILOT_HOME=<configDir> copilot login (its models are named `copilot:<id>`, e.g. copilot:claude-sonnet-5.5).
  // accounts: [{ name: "main" }, { name: "spare", configDir: "/root/.claude-spare" }, { name: "gpt", harness: "codex" }],
  // Read-only dashboard (docs/setup.md step 4), on by default at 127.0.0.1:8080; `dashboard: false` turns it off.
  // "Sign in with GitHub" lets only the Owner in; it is on by default and the pages answer 503 until it is set up with
  // a GitHub OAuth App (callback URL: the dashboard's URL + /auth/callback). `githubLogin: false` turns it off.
  // tokenPath (optional): a token for scripts, sent as `Authorization: Bearer <token>`. Off loopback, the dashboard
  // needs the sign-in or a token.
  dashboard: {
    port: 8080,
    githubLogin: { clientId: "Ov23li…", clientSecretPath: "/root/.config/coordinator/github-client-secret" },
    // tokenPath: "/root/.config/coordinator/dashboard-token",
  },
});
