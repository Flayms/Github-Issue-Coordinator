# Setup

How to run the Coordinator on a server. The Owner does these steps once; nothing here is needed again during normal use. `bun run doctor` checks the result.

## 1. Linux user, tools and Claude login

The Coordinator and its agent sessions run as one Linux user. A dedicated user (here `agent`) keeps the agents away from your own home directory, SSH keys and credentials:

```sh
sudo adduser --disabled-password agent
sudo -iu agent
curl -fsSL https://bun.sh/install | bash        # Bun
curl -fsSL https://claude.ai/install.sh | bash  # Claude Code
sudo apt-get install -y tmux git bubblewrap     # as an admin user: tmux, git, the sandbox
```

Then, still as that user, log in to Claude once with the subscription. Remote Control does not work with `claude setup-token`, so this must be the interactive login:

```sh
claude          # then /login, and /exit when done
```

## 2. GitHub App (the Coordinator's identity)

Create a private GitHub App: GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- Name: anything, e.g. `my-issue-coordinator`. Homepage URL: this repository.
- Webhook: **off** (the Coordinator polls).
- Repository permissions: **Issues** read & write, **Pull requests** read & write, **Contents** read & write, **Checks** read-only, **Metadata** read-only. Nothing else.
- Where can it be installed: **Only on this account**.

After creating it, note the **App ID**, generate a **private key** (a `.pem` file) and copy it to the server outside any repository, e.g. `/home/agent/.config/coordinator/app.pem` (`chmod 600`). Then **Install App** on the repositories the Coordinator should manage.

## 3. Ruleset on each managed repository

`Contents: write` lets the App push branches, but it must never change the default branch (REQ-001-15). In each managed repository: Settings → Rules → Rulesets → New branch ruleset:

- Target: the default branch. Enforcement: Active.
- Bypass list: only yourself (Repository admin / your user), not the App.
- Rules: **Restrict updates**, **Restrict deletions**, **Block force pushes**, and **Require a pull request before merging**.

## 4. Turn off the old review workflow

The Coordinator's Reviewer replaces any GitHub Actions workflow that reviews PRs with Claude. Disable it in each managed repository (Actions → the workflow → ⋯ → Disable workflow), or delete its file from `.github/workflows/`.

## 5. Install and configure

```sh
git clone https://github.com/<you>/Github-Issue-Coordinator.git ~/github-issue-coordinator
cd ~/github-issue-coordinator
bun install
cp config.example.ts config.ts
```

Fill in `config.ts`: your login and numeric id (`curl -s https://api.github.com/users/<login> | grep '"id"'`), the App ID and key path, the repositories (with their `setup` command, e.g. `bun install`), and a model per Role. Then:

```sh
bun run doctor
```

## 6. Run as a service

```sh
sudo cp deploy/github-issue-coordinator.service /etc/systemd/system/   # adjust User and paths if needed
sudo systemctl daemon-reload
sudo systemctl enable --now github-issue-coordinator
journalctl -u github-issue-coordinator -f                               # the log
```

Restarting the service leaves running agent sessions alone (`KillMode=process`); the Coordinator picks them up again. To look at a session on the server (you normally don't need to): `sudo -iu agent tmux attach -t coordinator`.

## Using it

See the README: open an issue, wait for the Assessment, approve with `/approve`, follow the sessions in the Claude app.
