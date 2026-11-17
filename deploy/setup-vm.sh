#!/usr/bin/env bash
# Sets up a VM for the Coordinator (docs/setup.md, step 1, REQ-005-06).
# Run once as the normal user the Coordinator and its agents will run as (not root; it needs sudo):
#   bash deploy/setup-vm.sh
# Safe to run again: every step skips what already exists.
set -euo pipefail

REPO_URL=https://github.com/Flayms/Github-Issue-Coordinator.git
UNIT=/etc/systemd/system/github-issue-coordinator.service

if [[ $EUID -eq 0 ]]; then
  echo "Run as the normal user the agents should run as, not root (Claude Code refuses skipped permissions as root)." >&2
  exit 1
fi

echo "== System packages (tmux, git, gh, curl, unzip)"
sudo apt-get update -qq
sudo apt-get install -y -qq tmux git gh curl unzip >/dev/null

echo "== Bun"
command -v bun >/dev/null || [ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash

echo "== Claude Code"
command -v claude >/dev/null || [ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash

echo "== PATH for bun and claude in login shells"
# The installers only extend ~/.bashrc, which non-interactive shells skip.
grep -q "coordinator: PATH" ~/.profile 2>/dev/null ||
  echo "export PATH=\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH  # coordinator: PATH" >> ~/.profile

echo "== Coordinator checkout and dependencies"
# The checkout this script runs from, or a fresh clone in ~/github-issue-coordinator.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [ -f "$HERE/package.json" ] && [ -d "$HERE/.git" ]; then CHECKOUT=$HERE; else CHECKOUT=$HOME/github-issue-coordinator; fi
[ -d "$CHECKOUT/.git" ] || git clone -q "$REPO_URL" "$CHECKOUT"
(cd "$CHECKOUT" && ~/.bun/bin/bun install --frozen-lockfile)

echo "== systemd unit $UNIT (for $USER)"
sed -e "s#@USER@#$USER#g" -e "s#@HOME@#$HOME#g" -e "s#@CHECKOUT@#$CHECKOUT#g" \
  "$CHECKOUT/deploy/github-issue-coordinator.service" | sudo tee "$UNIT" >/dev/null
sudo systemctl daemon-reload

cat <<DONE

Done. Next:
  claude                 # log in once with your subscription: /login, then /exit
  gh auth login          # paste the fine-grained PAT (docs/setup.md step 2)
  cp $CHECKOUT/config.example.ts $CHECKOUT/config.ts   # and fill it in (step 5)
  cd $CHECKOUT && bun run doctor
  sudo systemctl enable --now github-issue-coordinator
DONE
