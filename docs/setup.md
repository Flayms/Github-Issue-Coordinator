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

- **Ruleset** (Settings → Rules → Rulesets → New branch ruleset): target the default branch, empty bypass list, rules **Restrict deletions**, **Block force pushes**, **Require a pull request before merging** (0 approvals). This keeps pushes off the default branch; merging is left to you by the prompts.
- **Old review workflow:** disable any GitHub Actions workflow that reviews PRs with Claude; the Reviewer replaces it.

## 3. Configure

Copy `config.example.ts` to `config.ts` and fill in:

- `owner`: your login and numeric id (`gh api users/<login> --jq .id`).
- `roles`: a model per Role (`sonnet`, `opus`, …), optionally an effort.
- `repos`: each managed repository, with its `setup` command (e.g. `bun install`) for new Worktrees.
- Optional: `stateDir`, `limits`, `accounts`, `dashboard`, `github.commitAuthor` (see `config.example.ts`).

**More than one subscription (optional):** when one hits its usage limit, the Coordinator goes on with the next ([spec 004](specs/004-accounts/spec.md)). Log in to each extra one in its own folder (`CLAUDE_CONFIG_DIR=/root/.claude-spare claude`, then `/login`) and list them in `accounts`. A session shows up in the Claude app only under the account it runs on.

## 4. Dashboard (optional)

On by default at `127.0.0.1:8080`, read-only ([spec 003](specs/003-dashboard/spec.md)). Reach it over Tailscale (`tailscale serve --bg 8080`) or an SSH tunnel (`ssh -N -L 8080:127.0.0.1:8080 root@<vm>`), never directly from the internet. To require a token:

```sh
mkdir -p ~/.config/coordinator && (umask 077 && openssl rand -hex 32 > ~/.config/coordinator/dashboard-token)
```

```ts
dashboard: { tokenPath: "/root/.config/coordinator/dashboard-token" },
```

Open it once as `…/?token=<token>`; a cookie keeps it from then on. `dashboard: false` turns it off.

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
