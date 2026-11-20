# Setup

One-time steps to get the Coordinator running. Work through them in order; `bun run doctor` checks the result.

| Step                                                                        | Needed                        |
| --------------------------------------------------------------------------- | ----------------------------- |
| [Prerequisites](#prerequisites)                                             | **Required**                  |
| [1. GitHub access: a fine-grained PAT](#1-github-access-a-fine-grained-pat) | **Required**                  |
| [2. Each managed repository](#2-each-managed-repository)                    | **Required**                  |
| [3. Configure](#3-configure)                                                | **Required**                  |
| [4. Dashboard](#4-dashboard)                                                | On by default; sign-in needed |
| [5. Run as a service](#5-run-as-a-service)                                  | Recommended                   |
| [6. Verify](#6-verify)                                                      | **Required**                  |

> [!IMPORTANT]
> Everything runs as root on a VM dedicated to the Coordinator. Agents run with permission prompts skipped and no sandbox, so keep nothing else of value there. The Coordinator starts them with `IS_SANDBOX=1`, without which Claude Code refuses that as root ([spec 005](specs/005-vm-runtime/spec.md)). The only boundary is GitHub: the PAT in step 1.

## Prerequisites

**Required.** A Linux VM (e.g. Ubuntu), used as root.

- [ ] tmux, git and the GitHub CLI:

  ```sh
  apt install -y tmux git gh
  ```
- [ ] [Bun](https://bun.sh):

  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```
- [ ] [Claude Code](https://code.claude.com):

  ```sh
  curl -fsSL https://claude.ai/install.sh | bash
  ```
- [ ] Run `claude` once and `/login` with your subscription. Remote Control needs this login, not `claude setup-token`.
- [ ] The Coordinator itself:

  ```sh
  git clone https://github.com/Flayms/Github-Issue-Coordinator.git ~/github-issue-coordinator
  cd ~/github-issue-coordinator && bun install
  ```

## 1. GitHub access: a fine-grained PAT

**Required.** GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.

| Setting           | Value                                                                            |
| ----------------- | -------------------------------------------------------------------------------- |
| Resource owner    | The account that owns the repositories (your own for your personal repositories) |
| Repository access | **Only select repositories**: the ones the Coordinator should manage             |
| Read & write      | **Contents**, **Issues**, **Pull requests**, **Workflows**                       |
| Read-only         | **Commit statuses**, **Actions**                                                 |

- [ ] Create the token with the settings above.
- [ ] Log in with it:

  ```sh
  gh auth login --with-token <<< 'github_pat_…'
  ```

Good to know:

- The Coordinator reads it with `gh auth token` and picks up a new one within 5 minutes.
- Its comments show as yours. It recognises its own by the agent note they start with (REQ-005-03), so don't start a comment of your own with it.
- If `bun run doctor` says check runs aren't readable, add the read permission GitHub offers for checks.

## 2. Each managed repository

**Required**, for every repository in `repos`.

- [ ] **Add a ruleset:** Settings → Rules → Rulesets → New branch ruleset.

  | Setting       | Value                                                                                                                      |
  | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
  | Target        | The default branch                                                                                                         |
  | Bypass list   | Empty                                                                                                                      |
  | Rules         | **Restrict deletions**                                                                                                     |
  |               | **Block force pushes**                                                                                                     |
  |               | **Require a pull request before merging** (0 approvals)                                                                    |
  | Optional rule | **Require status checks to pass**, if the repository has CI (for this repository: `check` from `.github/workflows/ci.yml`) |

  This keeps pushes off the default branch. Agents never merge; the Coordinator merges only what `autoMerge` allows (step 3; by default PRs rated low risk), and only within these rules.
- [ ] **Disable the old review workflow:** any GitHub Actions workflow that reviews PRs with Claude. The Reviewer replaces it.

## 3. Configure

**Required.**

- [ ] Copy the example:

  ```sh
  cp config.example.ts config.ts
  ```
- [ ] Fill in:

  | Key     | What                                                                                     |
  | ------- | ---------------------------------------------------------------------------------------- |
  | `owner` | Your login and numeric id (`gh api users/<login> --jq .id`)                              |
  | `roles` | A model per Role (`sonnet`, `opus`, …), optionally an effort                             |
  | `repos` | Each managed repository, with its `setup` command (e.g. `bun install`) for new Worktrees |

**Optional:** `stateDir`, `limits`, `autoMerge`, `accounts`, `dashboard`, `github.commitAuthor` (see `config.example.ts`).

### Auto-merge (optional)

- [ ] Choose `autoMerge`. By default (`"evaluated"`) the Coordinator squash-merges reviewed PRs the Reviewer rated low risk. Set `"off"` to merge every PR yourself, or `"all"` for every reviewed PR whose checks passed. A repository's own `autoMerge` wins.

Good to know:

- Once signed in, you can also change both on the dashboard's Config page.
- The old name `"risk-evaluated"` still works; `bun run doctor` warns about it.
- The PAT's **Contents** and **Pull requests** write permissions already allow it.
- The ruleset from step 2 allows it as long as it requires 0 approvals. A ruleset or branch protection that requires an approving review (or anything else the PAT can't satisfy) makes GitHub refuse the merge; the PR is then left ready for you with GitHub's reason in a comment.

### More than one subscription (optional)

When one Account hits its usage limit, the Coordinator goes on with the next ([spec 004](specs/004-accounts/spec.md)).

- [ ] Log in to each extra one in its own folder:

  ```sh
  CLAUDE_CONFIG_DIR=/root/.claude-spare claude   # then /login
  ```
- [ ] List them in `accounts`.

A session shows up in the Claude app only under the Account it runs on.

### Codex CLI (optional)

To run a Role on an OpenAI model, add a Codex CLI login as an Account with `harness: "codex"` and pick a Codex model for the Role ([Harnesses](harnesses.md#setting-up-codex-cli)):

- [ ] `npm i -g @openai/codex` (0.170.0 or newer)
- [ ] `CODEX_HOME=/root/.codex codex login` (a ChatGPT plan, or `--with-api-key`)
- [ ] `accounts: [{ name: "main" }, { name: "gpt", harness: "codex", configDir: "/root/.codex" }]`
- [ ] `bun run doctor` checks `codex` and its login.

### Antigravity CLI (optional)

To run a Role on a Gemini model, add Google's Antigravity CLI as an Account with `harness: "antigravity"` and pick a Gemini model for the Role. A free personal Google login is enough ([Harnesses](harnesses.md#setting-up-antigravity-cli)):

- [ ] `curl -fsSL https://antigravity.google/cli/install.sh | bash` (1.5.12 or newer, into `~/.local/bin`)
- [ ] Run `agy` once as the Coordinator's user, sign in (over SSH it prints a URL and asks for the code) and finish its first-run screens.
- [ ] `accounts: [{ name: "main" }, { name: "gemini", harness: "antigravity" }]`: one Antigravity Account, without `configDir`, since `agy` keeps one login per user.
- [ ] `bun run doctor` checks `agy` and its login.

### Copilot CLI (optional)

To run a Role on one of the models a GitHub Copilot plan offers (Claude, GPT, Gemini, Grok), add a Copilot CLI login as an Account with `harness: "copilot"` and pick a `copilot:` model for the Role ([Harnesses](harnesses.md#setting-up-copilot-cli)):

- [ ] `npm i -g @github/copilot` (1.0.114 or newer)
- [ ] `COPILOT_HOME=/root/.copilot copilot login`; without a keyring, let it store the token in `config.json`
- [ ] `accounts: [{ name: "main" }, { name: "copilot", harness: "copilot", configDir: "/root/.copilot" }]`
- [ ] `bun run doctor` checks `copilot` and its login.

### OpenCode (optional)

To run a Role on a model OpenCode reaches, including its free Zen models, add OpenCode as an Account with `harness: "opencode"` and pick an `opencode:<provider>/<model>` model for the Role ([Harnesses](harnesses.md#setting-up-opencode)):

- [ ] `bun i -g opencode-ai` (1.19.6 or newer)
- [ ] For a free Zen model (e.g. `opencode:opencode/big-pickle`) nothing else; for another provider `opencode providers login`, or its API key in the Coordinator's environment.
- [ ] `accounts: [{ name: "main" }, { name: "zen", harness: "opencode" }]`: one OpenCode Account, without `configDir`.
- [ ] `bun run doctor` checks `opencode` and that it offers a model.

## 4. Dashboard

**On by default** at `127.0.0.1:8080` ([spec 003](specs/003-dashboard/spec.md)); `dashboard: false` turns it off. Until the sign-in is set up, its pages answer 503.

### Reach it

- [ ] Keep it on loopback and use one of these, never the open internet:
  - Tailscale: `tailscale serve --bg 8080`
  - an SSH tunnel: `ssh -N -L 8080:127.0.0.1:8080 root@<vm>`

### Sign in with GitHub

**Required** unless you turn it off. Only the Owner gets in.

- [ ] Create an OAuth App: GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.

  | Field                      | Value                                                                                                                         |
  | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
  | Homepage URL               | The URL you open the dashboard with, e.g. `https://<vm>.<tailnet>.ts.net` (Tailscale) or `http://127.0.0.1:8080` (SSH tunnel) |
  | Authorization callback URL | That URL + `/auth/callback`, e.g. `https://<vm>.<tailnet>.ts.net/auth/callback`                                               |

  Open the dashboard with exactly that host, or the sign-in ends with 400.
- [ ] Generate a client secret and keep it in a file:

  ```sh
  mkdir -p ~/.config/coordinator && (umask 077 && cat > ~/.config/coordinator/github-client-secret) # paste, then Ctrl-D
  ```
- [ ] Add it to `config.ts`:

  ```ts
  dashboard: { githubLogin: { clientId: "Ov23li…", clientSecretPath: "/root/.config/coordinator/github-client-secret" } },
  ```

Good to know:

- The sign-in asks for no scopes: it reads only who you are and drops GitHub's token right after.
- The session lasts 30 days, also across restarts. Its key is `<stateDir>/dashboard-session.key`; deleting it signs everyone out.
- "Sign out" is in the header.
- `githubLogin: false` turns the sign-in off, for loopback-only use.

### Token for scripts (optional)

- [ ] Create one:

  ```sh
  (umask 077 && openssl rand -hex 32 > ~/.config/coordinator/dashboard-token)
  ```
- [ ] Add it to `config.ts`:

  ```ts
  dashboard: { tokenPath: "/root/.config/coordinator/dashboard-token", githubLogin: { … } },
  ```

Send it as `Authorization: Bearer <token>`, or open the dashboard once as `…/?token=<token>` and a cookie keeps it. Off loopback, the dashboard needs the sign-in or a token.

### Settings on the Config page

- Once signed in, the Config page lets you change the limits, the poll interval, `checksGraceSeconds`, the auto-merge mode and each Role's model and effort (globally and per repository). The dashboard changes nothing on GitHub.
- They apply from the next tick on and are kept in `<stateDir>/config.overrides.json`, over `config.ts`. Delete that file (and restart) to go back to `config.ts`.
- Repositories, Accounts, access and `setup` commands change only in `config.ts`.

## 5. Run as a service

**Recommended** (otherwise `bun start`). The unit assumes the checkout at `/root/github-issue-coordinator`; adjust its paths otherwise.

- [ ] Install and start it:

  ```sh
  cp deploy/github-issue-coordinator.service /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now github-issue-coordinator
  ```
- [ ] Follow its log:

  ```sh
  journalctl -u github-issue-coordinator -f
  ```

Restarts leave running agent sessions alone; the Coordinator picks them up again. To watch one directly: `tmux attach -t coordinator`.

## 6. Verify

- [ ] `bun run doctor` says "All set." (it names the step to fix otherwise).
- [ ] Open the dashboard and sign in with GitHub.
- [ ] Open an issue in a managed repository: once a Planner Slot is free, it gets `agent:planning`, then an Assessment.

## Later

- **Add a repository:** add it to the PAT, set up step 2, add it to `repos`, `bun run doctor`, `systemctl restart github-issue-coordinator`.
- **Update:** `git pull && bun install && systemctl restart github-issue-coordinator`.
