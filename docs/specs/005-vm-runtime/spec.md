# 005 – VM runtime

**Status:** Implemented

## Goal

The Coordinator protected the host from its agents: a dedicated Linux user, Claude Code's bubblewrap sandbox (with an AppArmor change on Ubuntu), per-Role tool allowlists, deny rules for secret files, a network allowlist, and workarounds for what the sandbox broke (headless browser flags, read-only home folder, `git add -A`). That machinery costs more than it protects, and it keeps agents from doing ordinary work. Instead, the Coordinator runs on a VM dedicated to it, as a normal user with `sudo`, and agents may do on that machine whatever they want. The only boundary that stays is GitHub: everything on the VM uses one fine-grained personal access token (PAT), set up with the GitHub CLI, whose repositories and permissions the Owner chooses.

## Requirements

Deprecates REQ-001-15, REQ-001-25, REQ-001-26, REQ-001-30, REQ-001-53, REQ-001-55, REQ-001-56, REQ-002-07, REQ-003-10 and REQ-004-02; changes REQ-002-13 and REQ-002-14.

### REQ-005-01 Agents run unrestricted

- **Given** any agent session (Planner, Implementer or Reviewer)
- **When** it is started or resumed
- **Then** it runs as the Coordinator's own user with Claude Code's permission prompts skipped, so it never waits for a permission
- **And** this works when that user is root, the documented setup: the session is started with `IS_SANDBOX=1`, which Claude Code needs to skip permissions as root
- **And** its shell commands run without a sandbox: they may read and write any file the user can, reach any host, and use `sudo`
- **And** the session's settings hold only the Coordinator's hooks: no permission rules, no sandbox settings
- **And** when Claude Code asks once whether to accept running with skipped permissions ("Bypass Permissions mode"), the Coordinator accepts, so the session starts without the Owner

### REQ-005-02 GitHub access is one fine-grained PAT through the GitHub CLI

- **Given** the GitHub CLI logged in on the VM with a fine-grained PAT (`gh auth login`, or `GH_TOKEN`)
- **When** the Coordinator calls GitHub (REST, GraphQL, git fetch and push)
- **Then** it uses the token `gh auth token` returns, and no other GitHub credential exists on the VM
- **And** a token changed with `gh` reaches the Coordinator within 5 minutes, without a restart
- **And** agents read GitHub with `gh` as the same user, with the same token
- **And** the config needs no GitHub App, key or token path
- **And** the token is never written into a clone or Worktree, so it can't end up in a commit or a pushed config

### REQ-005-03 The Coordinator's own posts are not the Owner's

- **Given** a PAT of the Owner's own account, so the Coordinator's comments and reviews carry the Owner's id
- **When** the Coordinator reads the Owner's comments and reviews (feedback, `/approve`, `/agent`, `/wake`, Request changes)
- **Then** a comment or review that starts with the agent note (REQ-001-29) is not the Owner's and is ignored

### REQ-005-04 Agents leave GitHub writes to the Coordinator

- **Given** the default prompt of any Role
- **When** the session works
- **Then** it is told that it may read GitHub with `gh`, but that the Coordinator posts, labels, pushes and opens PRs, so it does none of that itself and never merges
- **And** the Planner and the Reviewer are told not to change the repository's files or git history (installing tools is fine)

### REQ-005-05 The setup check fits the VM

- **Given** `bun run doctor` on the VM
- **When** it runs
- **Then** it fails if `gh` is missing or not logged in, if the token's account isn't known, or if the token can't push to a configured repository
- **And** it says whether the token's account is the Owner's
- **And** it no longer checks bubblewrap, socat, AppArmor or a GitHub App

### REQ-005-06 One script sets up the VM

> **Deprecated** (#94 follow-up): Bun, Claude Code and the system tools are prerequisites in the README; the systemd unit is copied by hand (docs/setup.md). The script installed nothing a few documented commands don't.

- **Given** a fresh Ubuntu VM
- **When** the Owner runs `bash deploy/setup-vm.sh` as root, or as a normal user with `sudo`
- **Then** it installs tmux, git, curl, unzip and the GitHub CLI, Bun and Claude Code for that user, clones the Coordinator (or uses the checkout it runs from), installs its dependencies, and writes the systemd unit for that user
- **And** the systemd unit runs the Coordinator as the user that ran the script
- **And** it creates no other Linux user and installs no sandbox tools; running it again changes nothing that already exists

## Out of scope

- Protecting the VM from its agents, or anything on it from them (other files, the Claude logins, the dashboard token, the network). The VM is meant to hold nothing else of value and to be restorable.
- Restricting what the PAT can do beyond the repositories and permissions chosen for it: an agent could post or push with it. The default branch stays protected by the ruleset (docs/setup.md), and the prompts tell agents to leave GitHub writes to the Coordinator (REQ-005-04).
- Separate credentials for the Coordinator and the agents: anything the Coordinator can read, an agent with `sudo` can read too.

## Assumptions

- Fine-grained PATs can't reach repositories of another personal account, so for the Owner's personal repositories the PAT is the Owner's own and the Coordinator's posts carry the Owner's id; the agent note tells them apart (REQ-005-03). A PAT of a separate bot account (e.g. for organisation repositories) works as well.
- The fine-grained PAT has Contents, Issues, Pull requests and Workflows read & write, and Commit statuses and Actions read, for the managed repositories only. That this is enough to read check runs is not verified yet; `bun run doctor` checks it per repository.
- Claude Code asks once per config folder (Account) to accept skipped permissions; the answer is kept there.
- Claude Code refuses skipped permissions as root unless `IS_SANDBOX=1` is set (checked with Claude Code 2.1.326: refused without it, runs with it). So the Coordinator runs as root and needs no extra user.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Result                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| REQ-005-01 | `session runner > REQ-005-01 every Role starts with permission prompts skipped and no add-dir`; `… session settings hold only the hooks, for every Role`; `… a resume rewrites the settings without permissions or sandbox`; `… accepts the Bypass Permissions warning`; `… every session is started with IS_SANDBOX=1, so skipped permissions also work as root`; `claude command line > REQ-001-18 / REQ-001-22 / REQ-005-01 registers with Remote Control …`; `config > REQ-005-01 repositories have no sandbox domains any more`; manual: `bun scripts/smoke-runner.ts` on the VM (no permission prompt, commit works, sudo) | pass (manual open)           |
| REQ-005-02 | `gh token > REQ-005-02 reads the token from gh auth token, the same for every repository`; `… reads it again after 5 minutes, so a token changed with gh needs no restart`; `… a failing gh says how to log in, and is asked again next time`; `… an empty token is an error`; `config > REQ-005-02 needs no GitHub App: the token comes from gh, and App settings are refused`; `GitHub client > REQ-005-02 authenticates every request with the token from gh`; `git > REQ-005-02 never stores the token in the clone`, `… passes the token as a one-off HTTP header`; `worktrees > REQ-005-02 the checkout holds no token …`  | pass                         |
| REQ-005-03 | `reconcile loop > REQ-005-03 the Coordinator's own comments under the Owner's id are not feedback`; `… the Coordinator's own reviews and comments under the Owner's id don't start a round on a PR`; `agent note > REQ-005-03 recognises the agent note at the start of a body`                                                                                                                                                                                                                                                                                                                                                  | pass                         |
| REQ-005-04 | `prompts (REQ-002) > REQ-005-04 every default prompt leaves GitHub writes to the Coordinator`; `… Planner and Reviewer don't change the repository; the Implementer may use sudo`                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass (wording only)          |
| REQ-005-05 | manual: `bun run doctor` on the VM (talks to the real `gh`, `claude` and GitHub); run here as root with a fixture config                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass (manual on the VM open) |
| REQ-005-06 | Deprecated; `deploy/setup-vm.sh` was removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                            |
