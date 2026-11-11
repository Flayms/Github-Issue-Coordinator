#!/usr/bin/env bash
# Creates the dedicated `agent` Linux user for the Coordinator (docs/setup.md, step 1).
# Run once as an admin:  sudo bash deploy/create-agent-user.sh
# Safe to run again: every step skips what already exists.
set -euo pipefail

AGENT=agent
REPO_URL=https://github.com/Flayms/Github-Issue-Coordinator.git
CHECKOUT=/home/$AGENT/github-issue-coordinator

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0" >&2
  exit 1
fi

echo "== System packages (tmux, git, sandbox: bubblewrap + socat)"
apt-get update -qq
apt-get install -y -qq tmux git bubblewrap socat curl unzip >/dev/null

echo "== User $AGENT"
if id "$AGENT" &>/dev/null; then
  echo "exists"
else
  adduser --disabled-password --gecos "GitHub Issue Coordinator" "$AGENT"
fi
chmod 750 "/home/$AGENT"

as_agent() { sudo -iu "$AGENT" bash -lc "$1"; }

echo "== Bun (as $AGENT)"
as_agent 'command -v bun >/dev/null || [ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash'

echo "== Claude Code (as $AGENT)"
as_agent 'command -v claude >/dev/null || [ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash'

echo "== Coordinator checkout and dependencies (as $AGENT)"
as_agent "[ -d $CHECKOUT/.git ] || git clone -q $REPO_URL $CHECKOUT"
as_agent "cd $CHECKOUT && ~/.bun/bin/bun install --frozen-lockfile"

echo "== Directory for the GitHub App key (as $AGENT)"
as_agent 'mkdir -p ~/.config/coordinator && chmod 700 ~/.config/coordinator'

cat <<EOF

Done. Next, log in to Claude as $AGENT (once, interactively):

  sudo -iu $AGENT
  claude              # answer the theme/trust questions, then type /login and follow the link
  /exit

Then continue with the GitHub App (docs/setup.md, step 2).
EOF
