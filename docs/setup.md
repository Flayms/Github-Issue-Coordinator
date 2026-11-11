# Setup

How to run the Coordinator on a server. The Owner does these steps once; nothing here is needed again during normal use. `bun run doctor` checks the result.

## 1. Linux user, tools and Claude login

The Coordinator and its agent sessions run as one Linux user. A dedicated user (here `agent`) keeps the agents away from your own home directory, SSH keys and credentials. As an admin, from a checkout of this repository:

```sh
sudo bash deploy/create-agent-user.sh
```

It installs tmux, git and the sandbox tools (bubblewrap, socat), creates the `agent` user, installs Bun and Claude Code for it, clones this repository to `/home/agent/github-issue-coordinator` and creates `~/.config/coordinator` for the GitHub App key. It is safe to run again.

**Ubuntu 24.04 and later:** Ubuntu's AppArmor profile `bwrap-userns-restrict` stops Claude Code's sandbox from working, and the Implementer then can't run any command. Replace it with the profile the [Claude Code sandboxing docs](https://code.claude.com/docs/en/sandboxing) recommend. Both define the profile named `bwrap`, so Ubuntu's has to be turned off:

```sh
sudo ln -sf /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/
sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict
printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' \
  'profile bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' '  include if exists <local/bwrap>' '}' \
  | sudo tee /etc/apparmor.d/bwrap > /dev/null
sudo systemctl reload apparmor
```

`bun run doctor` checks this ("sandbox can nest user namespaces").

Then log in to Claude once as that user, with the subscription. Remote Control does not work with `claude setup-token`, so this must be the interactive login:

```sh
sudo -iu agent
claude          # then /login, and /exit when done
```

## 2. GitHub App (the Coordinator's identity)

Create a private GitHub App: GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- Name: anything, e.g. `my-issue-coordinator`. Homepage URL: this repository.
- Webhook: untick **Active** (the Coordinator polls).
- Repository permissions: **Issues** read & write, **Pull requests** read & write, **Contents** read & write, **Checks** read-only, **Metadata** read-only. Nothing else.
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

`config.ts` is not committed; it only exists on the server. One way to write it is in your own checkout, then hand it over:

```sh
sudo install -o agent -g agent -m 640 config.ts /home/agent/github-issue-coordinator/config.ts
```

Then check everything:

```sh
sudo -iu agent bash -lc 'cd ~/github-issue-coordinator && git pull -q && bun install && bun run doctor'
```

## 6. Run as a service

```sh
sudo cp deploy/github-issue-coordinator.service /etc/systemd/system/   # adjust User and paths if needed
sudo systemctl daemon-reload
sudo systemctl enable --now github-issue-coordinator
journalctl -u github-issue-coordinator -f                               # the log
```

Restarting the service leaves running agent sessions alone (`KillMode=process`); the Coordinator picks them up again. To look at a session on the server (you normally don't need to): `sudo -iu agent tmux attach -t coordinator`.

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
