# Setup

How to run the Coordinator on a VM. The Owner does these steps once; nothing here is needed again during normal use. `bun run doctor` checks the result.

## 1. VM, tools and Claude login

The Coordinator and its agents run on a VM dedicated to them, as one user ([spec 005](specs/005-vm-runtime/spec.md)). Agents run with Claude Code's permission prompts skipped and no sandbox: they may read and write anything on the VM, reach any host and install packages. So put nothing on the VM you wouldn't hand to them, and keep it easy to rebuild (a snapshot helps). The only boundary is GitHub: the fine-grained PAT of step 2.

That user can simply be **root**. Claude Code refuses skipped permissions as root unless `IS_SANDBOX=1` is set, and the Coordinator sets it for every session. A separate normal user adds no security here (with passwordless `sudo` an agent becomes root whenever it likes); if you prefer one anyway, give it `sudo` without a password, so agents don't stall at a password prompt:

```sh
echo "$USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/coordinator
```

Then, as that user (root or your sudo user), from a checkout of this repository:

```sh
bash deploy/setup-vm.sh
```

It installs tmux, git, the GitHub CLI (`gh`), Bun and Claude Code, uses this checkout (or clones it to `~/github-issue-coordinator`), installs its dependencies and writes the systemd unit for the user that ran it. It is safe to run again.

**Headless browser (optional, for Screenshots):** Implementers capture Screenshots of UI changes with a headless Chrome or Chromium (REQ-001-48). If none is installed, they install one themselves; to save them the time, install Google Chrome once:

```sh
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

`bun run doctor` reports the browser it finds and whether it starts headless. Published Screenshots go to the branch `agent-screenshots` of the repository (never to the default branch or the PR branch); you can delete old folders or the whole branch at any time, which only breaks the images of older PR bodies.

Then log in to Claude once, with the subscription. Remote Control does not work with `claude setup-token`, so this must be the interactive login:

```sh
claude          # then /login, and /exit when done
```

The first session the Coordinator starts asks once whether to accept "Bypass Permissions mode"; the Coordinator answers it.

**More than one subscription (optional).** When one subscription hits its usage limit, the Coordinator can go on with another one ([spec 004](specs/004-accounts/spec.md)). Each extra subscription is an Account with its own Claude config folder; log in to it once the same way, with the folder set:

```sh
CLAUDE_CONFIG_DIR=$HOME/.claude-spare claude   # then /login with the other subscription, and /exit
```

Then list the Accounts in `config.ts` (step 5). Good to know:

- Claude keeps its settings per folder, so an extra Account starts without your user settings and asks for folder trust and Bypass Permissions mode again; the Coordinator answers both.
- Each login expires on its own; `bun run doctor` checks every Account.
- A session shows up in the Claude app only under the claude.ai account it runs on. To follow a session on a fallback Account, switch accounts in the app.

## 2. GitHub access: a fine-grained PAT

The Coordinator and the agents use one GitHub credential: a fine-grained personal access token, logged in with the GitHub CLI. Whatever it may do, an agent on the VM may do too, so give it only the repositories the Coordinator manages.

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token:

- Resource owner: the account that owns the repositories. Fine-grained PATs can't reach another user's personal repositories, so for your own repositories this is your own account. The Coordinator's comments then show as yours; it tells its own posts apart from yours by the agent note they start with (REQ-005-03), so don't start a comment of your own with that note.
- Repository access: **Only select repositories** → the repositories the Coordinator should manage.
- Repository permissions: **Contents**, **Issues**, **Pull requests** and **Workflows** read & write; **Commit statuses** and **Actions** read-only (Metadata read-only is added by GitHub). The Reviewer waits for a PR's check runs; `bun run doctor` checks that the token can read them, and if it can't, add the read permission GitHub offers for checks. Workflows lets the Implementer push changes to `.github/workflows/`; without it GitHub rejects any push that touches a workflow file.
- Expiration: as long as you are comfortable with; renew it with `gh auth login` before it expires.

Then, on the VM:

```sh
gh auth login --with-token <<< 'github_pat_…'   # or `gh auth login` and paste it
gh auth status
```

The Coordinator reads the token with `gh auth token` (it also honours `GH_TOKEN`) and picks up a new one within 5 minutes, without a restart. `bun run doctor` checks that it can push to every configured repository and read its check runs.

## 3. Ruleset on each managed repository

`Contents: write` lets the token push branches, but nothing on the VM should change the default branch directly. In each managed repository: Settings → Rules → Rulesets → New branch ruleset:

- Target: the default branch. Enforcement: Active.
- Bypass list: empty. The PAT acts as you, so a bypass for you would be a bypass for the agents too.
- Rules: **Restrict deletions**, **Block force pushes**, and **Require a pull request before merging** (0 approvals, so you can still merge your agent PRs).

This keeps pushes off the default branch. It can't keep the token from merging a PR: the prompts tell agents to leave merging to you (REQ-005-04).

## 4. Turn off the old review workflow

The Coordinator's Reviewer replaces any GitHub Actions workflow that reviews PRs with Claude. Disable it in each managed repository (Actions → the workflow → ⋯ → Disable workflow), or delete its file from `.github/workflows/`.

## 5. Configure

Write `config.ts` in the checkout, starting from `config.example.ts`:

- `owner`: your login and numeric id (`gh api users/<login> --jq .id`).
- `stateDir`: where the store, session files and clones live, e.g. `/home/<you>/coordinator-state`.
- `roles`: a model per Role (`sonnet`, `opus`, …), optionally an effort.
- `repos`: each managed repository with its `setup` command (e.g. `bun install`), run once in every new Worktree.
- `accounts` (optional): your Claude subscriptions in priority order, e.g. `[{ name: "main" }, { name: "spare", configDir: "/home/<you>/.claude-spare" }]`. An Account without `configDir` is the login in `~/.claude` from step 1. Sessions run on the first Account that isn't paused by a usage limit. Leave it out for a single subscription.
- `github.commitAuthor` (optional): the author of the Implementer's commits (default `Claude <noreply@anthropic.com>`).

`config.ts` is not committed. Then check everything:

```sh
cd ~/github-issue-coordinator && bun run doctor
```

## 6. Dashboard (on by default)

A read-only web page with what is ready to merge, capacity, the running agents, what runs next and the pipeline, plus a Config page (`/config`) with the settings ([spec 003](specs/003-dashboard/spec.md)). It changes nothing: approving, feedback and merging stay on GitHub. It is on by default at `127.0.0.1:8080` without a token, and the log shows `dashboard on http://127.0.0.1:8080` at startup; `dashboard: false` in `config.ts` turns it off. If the port is taken, the Coordinator logs `dashboard not started: …` and keeps running.

Keep it on loopback (the default) and reach it over Tailscale or an SSH tunnel. Don't expose it on the internet: the machine runs agents that can push code. Use a token when `tailscale serve` forwards to it, so only you can open it from your tailnet. Agents on the VM can read the token like any other file (REQ-005-01); the dashboard is read-only, so that gives them nothing they don't have.

```sh
mkdir -p ~/.config/coordinator && (umask 077 && openssl rand -hex 32 > ~/.config/coordinator/dashboard-token)
```

```ts
dashboard: { port: 8080, tokenPath: "/home/<you>/.config/coordinator/dashboard-token" }, // host defaults to 127.0.0.1
```

- **Tailscale (recommended):** on the server, `sudo tailscale serve --bg 8080`. The page is then at `https://<machine>.<tailnet>.ts.net/` with HTTPS, and only devices in your tailnet can reach it.
- **SSH tunnel:** `ssh -N -L 8080:127.0.0.1:8080 <you>@<server>`, then `http://localhost:8080/`.

Open it once as `…/?token=<token>`: the token is then kept in a cookie and removed from the address, so a bookmark of `/` works from then on. Scripts can send `Authorization: Bearer <token>`. A host other than loopback (e.g. `0.0.0.0`) is refused without a `tokenPath`. The page reloads itself every `pollIntervalSec` and shows the state of the last tick; it makes no GitHub requests of its own. `/?repo=<owner>/<name>` narrows the pipeline to one repository. The "Copy name" buttons need HTTPS (`tailscale serve`) or `localhost`; otherwise the Remote Control name is shown as text only.

## 7. Run as a service

`deploy/setup-vm.sh` installed the unit for your user (step 1).

```sh
sudo systemctl enable --now github-issue-coordinator
journalctl -u github-issue-coordinator -f                               # the log
```

Restarting the service leaves running agent sessions alone (`KillMode=process`); the Coordinator picks them up again. To look at a session on the VM (you normally don't need to): `tmux attach -t coordinator`.

## Adding a repository later

1. Add it to the PAT's repositories (GitHub → Settings → Developer settings → Fine-grained tokens → the token → Edit).
2. Add the ruleset (step 3) and turn off any old review workflow (step 4).
3. Add it to `repos` in `config.ts`, run `bun run doctor`, and restart: `sudo systemctl restart github-issue-coordinator`.

## Updating the Coordinator

```sh
cd ~/github-issue-coordinator && git pull -q && bun install
sudo systemctl restart github-issue-coordinator
```

## Using it

See the README: open an issue, wait for the Assessment, approve with `/approve`, follow the sessions in the Claude app.
