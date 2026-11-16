# Setup

How to run the Coordinator on a server. The Owner does these steps once; nothing here is needed again during normal use. `bun run doctor` checks the result.

## 1. Linux user, tools and Claude login

The Coordinator and its agent sessions run as one Linux user. A dedicated user (here `agent`) keeps the agents away from your own home directory, SSH keys and credentials. As an admin, from a checkout of this repository:

```sh
sudo bash deploy/create-agent-user.sh
```

It installs tmux, git, the GitHub CLI (`gh`, which agents use to read GitHub with a read-only token, REQ-001-55) and the sandbox tools (bubblewrap, socat), creates the `agent` user, installs Bun and Claude Code for it, clones this repository to `/home/agent/github-issue-coordinator` and creates `~/.config/coordinator` for the GitHub App key. It is safe to run again.

**Ubuntu 24.04 and later:** Ubuntu's AppArmor profile `bwrap-userns-restrict` stops Claude Code's sandbox from working, and the Implementer then can't run any command. Replace it with the profile the [Claude Code sandboxing docs](https://code.claude.com/docs/en/sandboxing) recommend. Both define the profile named `bwrap`, so Ubuntu's has to be turned off:

```sh
sudo mkdir -p /etc/apparmor.d/disable   # does not exist on a fresh Ubuntu 26.04
sudo ln -sf /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/
sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict
printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' \
  'profile bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '  include if exists <local/bwrap>' '}' \
  | sudo tee /etc/apparmor.d/bwrap > /dev/null
sudo systemctl reload apparmor
```

The link in `disable/` is what keeps Ubuntu's profile from loading again at the next boot; without it the change only lasts until a reboot. `bun run doctor` checks both ("sandbox can nest user namespaces", "bwrap AppArmor change survives a reboot").

**Headless browser (optional, for Screenshots):** Implementers capture Screenshots of UI changes with a headless Chrome or Chromium on the host (REQ-001-48); their sandbox reaches only package registries, so they can't download one. Ubuntu's `chromium` package is a snap, which is not expected to start inside the sandbox, so install Google Chrome's `.deb`:

```sh
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

`bun run doctor` reports the browser it finds and whether it starts headless and writes a PNG ("headless browser for Screenshots"). To check that it also starts inside an Implementer's sandbox, run `bun scripts/smoke-runner.ts --screenshot` once as the Coordinator's user (it uses the subscription); it reports pass, the browser's error, or inconclusive if auto mode refused the command (docs/known-pitfalls.md). Without one, the Coordinator works as before and Implementers say in the PR that they couldn't capture Screenshots. Published Screenshots go to the branch `agent-screenshots` of the repository (never to the default branch or the PR branch); you can delete old folders or the whole branch at any time, which only breaks the images of older PR bodies.

Then log in to Claude once as that user, with the subscription. Remote Control does not work with `claude setup-token`, so this must be the interactive login:

```sh
sudo -iu agent
claude          # then /login, and /exit when done
```

**More than one subscription (optional).** When one subscription hits its usage limit, the Coordinator can go on with another one ([spec 004](specs/004-accounts/spec.md)). Each extra subscription is an Account with its own Claude config folder; log in to it once the same way, with the folder set:

```sh
sudo -iu agent
CLAUDE_CONFIG_DIR=/home/agent/.claude-spare claude   # then /login with the other subscription, and /exit
```

Then list the Accounts in `config.ts` (step 5). Good to know:

- Claude keeps its settings per folder, so an extra Account starts without your user settings and asks for folder trust again; the Coordinator answers the trust dialog as before.
- Each login expires on its own; `bun run doctor` checks every Account.
- A session shows up in the Claude app only under the claude.ai account it runs on. To follow a session on a fallback Account, switch accounts in the app.

## 2. GitHub App (the Coordinator's identity)

Create a private GitHub App: GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- Name: anything, e.g. `my-issue-coordinator`. Homepage URL: this repository.
- Webhook: untick **Active** (the Coordinator polls).
- Repository permissions: **Issues** read & write, **Pull requests** read & write, **Contents** read & write, **Workflows** read & write, **Checks** read-only, **Metadata** read-only. Nothing else. Workflows lets the Implementer push changes to `.github/workflows/`; without it GitHub rejects any push that touches a workflow file. Agent sessions get a second token of the same installation, limited to Contents, Issues, Pull requests, Checks and Metadata read-only (REQ-001-55), so they can read but never write.
- Where can it be installed: **Only on this account**.

After creating it:

1. Note the **App ID** at the top of the App's page.
2. **Generate a private key**; the browser downloads a `.pem` file.
3. **Install App** (left sidebar) → **Only select repositories** → the repositories the Coordinator should manage.

Copy the key to the server and hand it to the `agent` user; it must stay outside any repository and never be shared:

```sh
scp ~/Downloads/<app-name>.*.private-key.pem <you>@<server>:~/app.pem   # from your computer
sudo install -o agent -g agent -m 600 ~/app.pem /home/agent/.config/coordinator/app.pem   # on the server
rm ~/app.pem
```

If you change the App's permissions later, GitHub asks the installation to accept them: Settings → Applications → Installed GitHub Apps → **Configure** → review and accept the request. Until then the installation keeps the old permissions.

## 3. Ruleset on each managed repository

`Contents: write` lets the App push branches, but it must never change the default branch (REQ-001-15). In each managed repository: Settings → Rules → Rulesets → New branch ruleset:

- Target: the default branch. Enforcement: Active.
- Bypass list: only yourself (Repository admin / your user), not the App.
- Rules: **Restrict updates**, **Restrict deletions**, **Block force pushes**, and **Require a pull request before merging**.

## 4. Turn off the old review workflow

The Coordinator's Reviewer replaces any GitHub Actions workflow that reviews PRs with Claude. Disable it in each managed repository (Actions → the workflow → ⋯ → Disable workflow), or delete its file from `.github/workflows/`.

## 5. Configure

The setup script already cloned this repository for `agent` to `/home/agent/github-issue-coordinator`. Write `config.ts` there, starting from `config.example.ts`:

- `owner`: your login and numeric id (`curl -s https://api.github.com/users/<login> | grep '"id"'`).
- `github`: the App ID and the key path (`/home/agent/.config/coordinator/app.pem`).
- `stateDir`: where the store, session files and clones live, e.g. `/home/agent/coordinator-state`.
- `roles`: a model per Role (`sonnet`, `opus`, …), optionally an effort.
- `repos`: each managed repository with its `setup` command (e.g. `bun install`), run once in every new Worktree.
- `accounts` (optional): your Claude subscriptions in priority order, e.g. `[{ name: "main" }, { name: "spare", configDir: "/home/agent/.claude-spare" }]`. An Account without `configDir` is the login in `~/.claude` from step 1. Sessions run on the first Account that isn't paused by a usage limit. Leave it out for a single subscription.

`config.ts` is not committed; it only exists on the server. One way to write it is in your own checkout, then hand it over:

```sh
sudo install -o agent -g agent -m 640 config.ts /home/agent/github-issue-coordinator/config.ts
```

Then check everything:

```sh
sudo -iu agent bash -lc 'cd ~/github-issue-coordinator && git pull -q && bun install && bun run doctor'
```

## 6. Dashboard (on by default)

A read-only web page with what is ready to merge, capacity, the running agents, what runs next and the pipeline, plus a Config page (`/config`) with the settings ([spec 003](specs/003-dashboard/spec.md)). It changes nothing: approving, feedback and merging stay on GitHub. It is on by default at `127.0.0.1:8080` without a token, and the log shows `dashboard on http://127.0.0.1:8080` at startup; `dashboard: false` in `config.ts` turns it off. If the port is taken, the Coordinator logs `dashboard not started: …` and keeps running.

Keep it on loopback (the default) and reach it over Tailscale or an SSH tunnel. Don't expose it on the internet: the machine runs agents that can push code. Use a token even on loopback, because `tailscale serve` forwards from localhost and the agents run on the same machine. The Coordinator denies every agent session reading the token's folder.

```sh
sudo -iu agent bash -lc 'umask 077 && openssl rand -hex 32 > ~/.config/coordinator/dashboard-token'
```

```ts
dashboard: { port: 8080, tokenPath: "/home/agent/.config/coordinator/dashboard-token" }, // host defaults to 127.0.0.1
```

- **Tailscale (recommended):** on the server, `sudo tailscale serve --bg 8080`. The page is then at `https://<machine>.<tailnet>.ts.net/` with HTTPS, and only devices in your tailnet can reach it.
- **SSH tunnel:** `ssh -N -L 8080:127.0.0.1:8080 <you>@<server>`, then `http://localhost:8080/`.

Open it once as `…/?token=<token>`: the token is then kept in a cookie and removed from the address, so a bookmark of `/` works from then on. Scripts can send `Authorization: Bearer <token>`. A host other than loopback (e.g. `0.0.0.0`) is refused without a `tokenPath`. The page reloads itself every `pollIntervalSec` and shows the state of the last tick; it makes no GitHub requests of its own. `/?repo=<owner>/<name>` narrows the pipeline to one repository. The "Copy name" buttons need HTTPS (`tailscale serve`) or `localhost`; otherwise the Remote Control name is shown as text only.

## 7. Run as a service

```sh
sudo cp deploy/github-issue-coordinator.service /etc/systemd/system/   # adjust User and paths if needed
sudo systemctl daemon-reload
sudo systemctl enable --now github-issue-coordinator
journalctl -u github-issue-coordinator -f                               # the log
```

Restarting the service leaves running agent sessions alone (`KillMode=process`); the Coordinator picks them up again. To look at a session on the server (you normally don't need to): `sudo -iu agent tmux -S <stateDir>/tmux/coordinator.sock attach -t coordinator`. The Coordinator runs tmux on that socket of its own, so Implementers' sandboxes can hide it (REQ-001-58).

**Upgrading from a Coordinator before #90** (which used tmux's default socket): deploy while no agent session runs. The Coordinator then ends the old tmux session, which holds only its `keepalive` window, and starts. If an agent session still runs there, the Coordinator refuses to start and names it in the log; let it finish, or end it with `sudo -iu agent tmux kill-session -t coordinator`, then restart the service.

**Keep the `agent` user out of `docker`, `lxd`, `incus`, `libvirt` and `podman`.** Implementers' sandboxes may open Unix sockets (for the headless browser, REQ-001-53); they hide the Coordinator's own control sockets, but not a root daemon's socket such as `/var/run/docker.sock`. `bun run doctor` warns when `agent` is in one of these groups.

## Adding a repository later

1. Install the App on it (Settings → Applications → Installed GitHub Apps → Configure → add the repository).
2. Add the ruleset (step 3) and turn off any old review workflow (step 4).
3. Add it to `repos` in `config.ts`, run `bun run doctor`, and restart: `sudo systemctl restart github-issue-coordinator`.

## Updating the Coordinator

```sh
sudo -iu agent bash -lc 'cd ~/github-issue-coordinator && git pull -q && bun install'
sudo systemctl restart github-issue-coordinator
```

## Using it

See the README: open an issue, wait for the Assessment, approve with `/approve`, follow the sessions in the Claude app.
