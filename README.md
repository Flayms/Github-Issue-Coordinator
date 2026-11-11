# github-issue-coordinator

A self-hosted Bun daemon that polls GitHub and runs Claude Code agents. They triage, plan, implement and review issues (one worktree per issue), with human approval gates.

## Setup (work in progress)

```sh
bun install
cp config.example.ts config.ts   # fill in the Owner, Roles and repositories
claude                           # once: /login with the Claude subscription
bun start                        # validates the config; the reconcile loop follows
```
