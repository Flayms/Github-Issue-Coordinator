# Setup

One-time steps after the [prerequisites](../README.md#prerequisites). `bun run doctor` checks the result.

Everything runs as root on the VM. Agents run with permission prompts skipped and no sandbox; the Coordinator starts them with `IS_SANDBOX=1`, without which Claude Code refuses that as root ([spec 005](specs/005-vm-runtime/spec.md)). The only boundary is GitHub: the PAT below.

## 1. GitHub access: a fine-grained PAT

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token:

- Resource owner: the account that owns the repositories (your own for your personal repositories). The Coordinator's comments then show as yours; it recognises its own by the agent note they start with (REQ-005-03), so don't start a comment of your own with it.
- Repository access: **Only select repositories**, the ones the Coordinator should manage.
- Permissions: **Contents**, **Issues**, **Pull requests**, **Workflows** read & write; **Commit statuses**, **Actions** read-only. If `bun run doctor` says check runs aren't readable, add the read permission GitHub offers for checks.

```sh
gh auth login --with-token <<< 'github_pat_…'
```

The Coordinator reads it with `gh auth token` and picks up a new one within 5 minutes.

## 2. Each managed repository

- **Ruleset** (Settings → Rules → Rulesets → New branch ruleset): target the default branch, empty bypass list, rules **Restrict deletions**, **Block force pushes**, **Require a pull request before merging** (0 approvals). This keeps pushes off the default branch; agents never merge, and the Coordinator merges only with `autoMerge` on (step 3). Optional, if the repository has CI: add **Require status checks to pass** with its check (for this repository: `check` from `.github/workflows/ci.yml`).
- **Old review workflow:** disable any GitHub Actions workflow that reviews PRs with Claude; the Reviewer replaces it.

## 3. Configure

Copy `config.example.ts` to `config.ts` and fill in:

- `owner`: your login and numeric id (`gh api users/<login> --jq .id`).
- `roles`: a model per Role (`sonnet`, `opus`, …), optionally an effort.
- `repos`: each managed repository, with its `setup` command (e.g. `bun install`) for new Worktrees.
- Optional: `stateDir`, `limits`, `autoMerge`, `accounts`, `dashboard`, `github.commitAuthor` (see `config.example.ts`).

**Auto-merge (optional):** `autoMerge: "evaluated"` (recommended) lets the Coordinator squash-merge reviewed PRs the Reviewer rated low risk; `"all"` merges every reviewed PR whose checks passed; a repository's own `autoMerge` wins. Once signed in, you can also change both on the dashboard's Config page. The old name `"risk-evaluated"` still works; `bun run doctor` warns about it. The PAT's **Contents** and **Pull requests** write permissions already allow it. The ruleset from step 2 allows it as long as it requires 0 approvals: a ruleset or branch protection that requires an approving review (or anything else the PAT can't satisfy) makes GitHub refuse the merge, and the PR is then left ready for you with GitHub's reason in a comment.

**More than one subscription (optional):** when one hits its usage limit, the Coordinator goes on with the next ([spec 004](specs/004-accounts/spec.md)). Log in to each extra one in its own folder (`CLAUDE_CONFIG_DIR=/root/.claude-spare claude`, then `/login`) and list them in `accounts`. A session shows up in the Claude app only under the account it runs on.

## 4. Dashboard

On by default at `127.0.0.1:8080` ([spec 003](specs/003-dashboard/spec.md)). It changes nothing on GitHub; once you are signed in with GitHub, the Config page lets you change the limits, the poll interval, `checksGraceSeconds` and each Role's model and effort (globally and per repository). They apply from the next tick on and are kept in `<stateDir>/config.overrides.json`, over `config.ts`; delete that file (and restart) to go back to `config.ts`. Repositories, Accounts, access and `setup` commands change only in `config.ts`. Reach it over Tailscale (`tailscale serve --bg 8080`) or an SSH tunnel (`ssh -N -L 8080:127.0.0.1:8080 root@<vm>`), never directly from the internet. `dashboard: false` turns it off.

**Sign in with GitHub** (on by default): only the Owner gets in. Until it is set up, the pages answer 503. Create an OAuth App: GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:

- Homepage URL: the URL you open the dashboard with, e.g. `https://<vm>.<tailnet>.ts.net` (Tailscale) or `http://127.0.0.1:8080` (SSH tunnel).
- Authorization callback URL: that URL + `/auth/callback`, e.g. `https://<vm>.<tailnet>.ts.net/auth/callback`. Open the dashboard with exactly that host, or the sign-in ends with 400.
- Generate a client secret and keep it in a file:

```sh
mkdir -p ~/.config/coordinator && (umask 077 && cat > ~/.config/coordinator/github-client-secret) # paste, then Ctrl-D
```

```ts
dashboard: { githubLogin: { clientId: "Ov23li…", clientSecretPath: "/root/.config/coordinator/github-client-secret" } },
```

The sign-in asks for no scopes: it reads only who you are and drops GitHub's token right after. The session lasts 30 days, also across restarts; its key is `<stateDir>/dashboard-session.key` (deleting it signs everyone out). "Sign out" is in the header. `githubLogin: false` turns the sign-in off, for loopback-only use.

**Token for scripts (optional):**

```sh
(umask 077 && openssl rand -hex 32 > ~/.config/coordinator/dashboard-token)
```

```ts
dashboard: { tokenPath: "/root/.config/coordinator/dashboard-token", githubLogin: { … } },
```

Send it as `Authorization: Bearer <token>`, or open the dashboard once as `…/?token=<token>` and a cookie keeps it. Off loopback, the dashboard needs the sign-in or a token.

## 5. Run as a service

The unit assumes the checkout at `/root/github-issue-coordinator`; adjust its paths otherwise.

```sh
cp deploy/github-issue-coordinator.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now github-issue-coordinator
journalctl -u github-issue-coordinator -f
```

Restarts leave running agent sessions alone; the Coordinator picks them up again. To watch one directly: `tmux attach -t coordinator`.

## Later

- **Add a repository:** add it to the PAT, set up step 2, add it to `repos`, `bun run doctor`, `systemctl restart github-issue-coordinator`.
- **Update:** `git pull && bun install && systemctl restart github-issue-coordinator`.
