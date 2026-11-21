# Setup

One-time steps to get the Coordinator running. Work through them in order; `issueflow init` does steps 1, 3, 4 and 5 for you by asking a few questions, and `issueflow doctor` checks the result.

| Step                                                                        | Needed                        |
| --------------------------------------------------------------------------- | ----------------------------- |
| [Prerequisites](#prerequisites)                                             | **Required**                  |
| [1. GitHub access: a fine-grained PAT](#1-github-access-a-fine-grained-pat) | **Required**                  |
| [2. Each managed repository](#2-each-managed-repository)                    | **Required**                  |
| [3. Configure: `issueflow init`](#3-configure-issueflow-init)               | **Required**                  |
| [4. Dashboard](#4-dashboard)                                                | On by default; sign-in needed |
| [5. Run as a service](#5-run-as-a-service)                                  | Recommended                   |
| [6. Verify](#6-verify)                                                      | **Required**                  |
| [Releases (maintainers)](#releases-maintainers)                             | This repository only          |

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
- [ ] The Coordinator itself, which gives you the `issueflow` command:

  ```sh
  bun add -g issueflow
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
- [ ] Log in with it (`issueflow init` asks for it when the GitHub CLI isn't logged in yet):

  ```sh
  gh auth login --with-token <<< 'github_pat_…'
  ```

Good to know:

- The Coordinator reads it with `gh auth token` and picks up a new one within 5 minutes.
- Its comments show as yours. It recognises its own by the agent note they start with (REQ-005-03), so don't start a comment of your own with it.
- If `issueflow doctor` says check runs aren't readable, add the read permission GitHub offers for checks.

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

## 3. Configure: `issueflow init`

**Required.**

- [ ] Run the wizard:

  ```sh
  issueflow init
  ```

  | It asks for    | Then                                                                                                      |
  | -------------- | --------------------------------------------------------------------------------------------------------- |
  | GitHub login   | Checks `gh auth status`; without a login it shows the PAT's settings (step 1) and logs in with your token |
  | Owner          | Your login and numeric id, read from the token's account, to confirm                                      |
  | Repositories   | Picked from those the token can push to, each with a `setup` command guessed from its lockfile            |
  | Roles          | A model and effort per Role, the defaults preselected                                                     |
  | Dashboard      | Off, or on with Sign in with GitHub (step 4); optionally a token for scripts                              |
  | Extra Accounts | Optional; prints the login command for each                                                               |
  | Auto-merge     | `off`, `evaluated` or `all` (below)                                                                       |

  It writes `~/.config/issueflow/config.json`, runs `issueflow doctor` and offers to install the service (step 5). Run it again to change the answers: it offers to edit the file with its values preselected, and keeps the keys it doesn't ask about.

Good to know:

- The file is plain JSON. Its `"$schema"` points at the installed `config.schema.json`, so an editor such as VS Code completes and checks every key. `--config <path>` or `$ISSUEFLOW_CONFIG` use another file.
- **Optional keys** `init` doesn't ask about: `limits`, `pollIntervalSec`, `checksGraceSeconds`, `instructions`, `github.commitAuthor`, `stateDir`, a repository's own `roles`, `autoMerge` and `instructions`.
- State (the store, sessions, clones, Worktrees and the secret files `init` writes) is kept in `~/.local/share/issueflow/`, or in `stateDir`; a relative `stateDir` is read relative to the config file.
- While the service runs, a hand edit applies from the next tick on; an invalid one is logged and ignored. Repositories, Accounts, `owner`, `github`, `dashboard` and `stateDir` need `issueflow service restart`; the Config page names them until then.

### Auto-merge (optional)

- [ ] Choose `autoMerge`. By default (`"evaluated"`) the Coordinator squash-merges reviewed PRs the Reviewer rated low risk. Set `"off"` to merge every PR yourself, or `"all"` for every reviewed PR whose checks passed. A repository's own `autoMerge` wins.

Good to know:

- Once signed in, you can also change both on the dashboard's Config page.
- The old name `"risk-evaluated"` still works; `issueflow doctor` warns about it.
- The PAT's **Contents** and **Pull requests** write permissions already allow it.
- The ruleset from step 2 allows it as long as it requires 0 approvals. A ruleset or branch protection that requires an approving review (or anything else the PAT can't satisfy) makes GitHub refuse the merge; the PR is then left ready for you with GitHub's reason in a comment.

### More than one subscription (optional)

When one Account hits its usage limit, the Coordinator goes on with the next ([spec 004](specs/004-accounts/spec.md)).

- [ ] Log in to each extra one in its own folder:

  ```sh
  CLAUDE_CONFIG_DIR=/root/.claude-spare claude   # then /login
  ```
- [ ] List them in `accounts` (`issueflow init` adds them and prints these commands):

  ```json
  "accounts": [{ "name": "main" }, { "name": "spare", "configDir": "/root/.claude-spare" }]
  ```

A session shows up in the Claude app only under the Account it runs on.

### Codex CLI (optional)

To run a Role on an OpenAI model, add a Codex CLI login as an Account with `harness: "codex"` and pick a Codex model for the Role ([Harnesses](harnesses.md#setting-up-codex-cli)):

- [ ] `npm i -g @openai/codex` (0.170.0 or newer)
- [ ] `CODEX_HOME=/root/.codex codex login` (a ChatGPT plan, or `--with-api-key`)
- [ ] `"accounts": [{ "name": "main" }, { "name": "gpt", "harness": "codex", "configDir": "/root/.codex" }]`
- [ ] `issueflow doctor` checks `codex` and its login.

### Antigravity CLI (optional)

To run a Role on a Gemini model, add Google's Antigravity CLI as an Account with `harness: "antigravity"` and pick a Gemini model for the Role. A free personal Google login is enough ([Harnesses](harnesses.md#setting-up-antigravity-cli)):

- [ ] `curl -fsSL https://antigravity.google/cli/install.sh | bash` (1.5.12 or newer, into `~/.local/bin`)
- [ ] Run `agy` once as the Coordinator's user, sign in (over SSH it prints a URL and asks for the code) and finish its first-run screens.
- [ ] `"accounts": [{ "name": "main" }, { "name": "gemini", "harness": "antigravity" }]`: one Antigravity Account, without `configDir`, since `agy` keeps one login per user.
- [ ] `issueflow doctor` checks `agy` and its login.

### Copilot CLI (optional)

To run a Role on one of the models a GitHub Copilot plan offers (Claude, GPT, Gemini, Grok), add a Copilot CLI login as an Account with `harness: "copilot"` and pick a `copilot:` model for the Role ([Harnesses](harnesses.md#setting-up-copilot-cli)):

- [ ] `npm i -g @github/copilot` (1.0.114 or newer)
- [ ] `COPILOT_HOME=/root/.copilot copilot login`; without a keyring, let it store the token in `config.json`
- [ ] `"accounts": [{ "name": "main" }, { "name": "copilot", "harness": "copilot", "configDir": "/root/.copilot" }]`
- [ ] `issueflow doctor` checks `copilot` and its login.

### OpenCode (optional)

To run a Role on a model OpenCode reaches, including its free Zen models, add OpenCode as an Account with `harness: "opencode"` and pick an `opencode:<provider>/<model>` model for the Role ([Harnesses](harnesses.md#setting-up-opencode)):

- [ ] `bun i -g opencode-ai` (1.19.6 or newer)
- [ ] For a free Zen model (e.g. `opencode:opencode/big-pickle`) nothing else; for another provider `opencode providers login`, or its API key in the Coordinator's environment.
- [ ] `"accounts": [{ "name": "main" }, { "name": "zen", "harness": "opencode" }]`: one OpenCode Account, without `configDir`.
- [ ] `issueflow doctor` checks `opencode` and that it offers a model.

## 4. Dashboard

**On by default** at `127.0.0.1:8080` ([spec 003](specs/003-dashboard/spec.md)); `"dashboard": false` turns it off. Until the sign-in is set up, its pages answer 503. `issueflow init` does this step: it prints the two URLs to register, asks for the client id and secret, and writes the secret into a file only you can read.

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
- [ ] Generate a client secret and give it and the client id to `issueflow init`. It writes the secret to `~/.local/share/issueflow/github-client-secret` (mode 600) and the config gets:

  ```json
  "dashboard": {
    "githubLogin": {
      "clientId": "Ov23li…",
      "clientSecretPath": "/root/.local/share/issueflow/github-client-secret"
    }
  }
  ```

Good to know:

- The sign-in asks for no scopes: it reads only who you are and drops GitHub's token right after.
- The session lasts 30 days, also across restarts. Its key is `dashboard-session.key` in the state folder; deleting it signs everyone out.
- "Sign out" is in the header.
- `"githubLogin": false` turns the sign-in off, for loopback-only use.

### Token for scripts (optional)

- [ ] Let `issueflow init` generate one: it writes it to `~/.local/share/issueflow/dashboard-token` (mode 600) and sets `dashboard.tokenPath`.

Send it as `Authorization: Bearer <token>`, or open the dashboard once as `…/?token=<token>` and a cookie keeps it. Off loopback, the dashboard needs the sign-in or a token.

### Settings on the Config page

- Once signed in, the Config page lets you change the limits, the poll interval, `checksGraceSeconds`, the auto-merge mode and each Role's model and effort (globally and per repository). The dashboard changes nothing on GitHub.
- Saving writes them into `config.json` itself, keeping its other keys, their order and `$schema`; they apply from the next tick on. While the file on disk isn't valid (e.g. a half-done hand edit), saving is refused and the file is left alone.
- Repositories, Accounts, access and `setup` commands change only in the file, and apply after `issueflow service restart`.

## 5. Run as a service

**Recommended** (otherwise `issueflow start`). `issueflow init` offers this at the end.

- [ ] Install and start it:

  ```sh
  issueflow service install
  ```

  This writes `/etc/systemd/system/issueflow.service` from the actual environment (the paths of `bun` and `claude`, the installed package, the config in use, a `PATH` with `~/.local/bin` and `~/.bun/bin`), reloads systemd and enables and starts the service. Run it again after moving `bun` or the config.
- [ ] Follow its log:

  ```sh
  issueflow service logs
  ```

`issueflow service status`, `restart` and `uninstall` do what they say. Restarts leave running agent sessions alone (`KillMode=process`); the Coordinator picks them up again. To watch one directly: `tmux attach -t coordinator`.

## 6. Verify

- [ ] `issueflow doctor` says "All set." (it names the step to fix otherwise).
- [ ] Open the dashboard and sign in with GitHub.
- [ ] Open an issue in a managed repository: once a Planner Slot is free, it gets `agent:planning`, then an Assessment.

## Later

- **Add a repository:** add it to the PAT, set up step 2, then `issueflow init` → Edit it and pick it too (or add it to `repos` by hand), `issueflow doctor`, `issueflow service restart`.
- **Update:** `bun add -g issueflow@latest && issueflow service restart`. `issueflow doctor` says when a newer version is on npm.
- **From a checkout** (contributors): `bun install`, then `bun src/cli.ts <command>` in place of `issueflow <command>`.

## Releases (maintainers)

This repository only. [release-please](https://github.com/googleapis/release-please) keeps one release PR open (e.g. "chore(main): release 0.3.0") with the next version in `package.json` and `.release-please-manifest.json` and the entries in `CHANGELOG.md`, made from the squash-merge titles: `fix:` a patch, `feat:` a minor, `!` a major (a minor below 1.0). Merging it is the release: the tag and the GitHub Release are created, and `.github/workflows/release.yml` runs lint and tests on the tag and publishes it to npm ([spec 007](specs/007-install/spec.md)).

One-time setup:

- [ ] On npmjs.com, add this repository's `release.yml` as the trusted publisher of `issueflow` (OIDC, no npm token).
- [ ] Create a GitHub App with Contents and Pull requests read & write, install it on this repository only, and add its id and a private key as the Actions secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`. release-please opens its PR with this App's token, since a PR opened with `GITHUB_TOKEN` doesn't trigger `ci.yml`.
- [ ] Settings → Actions → General: allow GitHub Actions to create pull requests.
- [ ] Make the `title` check of `.github/workflows/pr-title.yml` required next to `check`.
