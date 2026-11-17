# 005 – VM runtime: Plan

## Approach

Remove, don't wrap. Every piece that existed only to contain agents goes; what stays is orchestration.

- **Sessions** (`src/runner.ts`, `src/prompts.ts`): `IS_SANDBOX=1 claude --dangerously-skip-permissions` for every Role (`IS_SANDBOX=1` lets it run as root). The per-session `settings.json` keeps only the hooks. No `--add-dir` (the Result file is writable without it), so the add-dir trust question disappears; the folder trust question stays, and the one-time Bypass Permissions warning is answered the same way (Down, Enter). `meta.json` keeps only the cwd. No `gh/hosts.yml`, no `GH_CONFIG_DIR`: agents use the user's own `gh` login.
- **GitHub** (`src/github/gh-token.ts`): one `GhToken` with the `tokenFor(repo)` shape the client, clones and Worktrees already use, backed by `gh auth token` and cached for 5 minutes. `app-auth.ts` and `read-tokens.ts` are deleted; the config loses `github.appId` and `github.privateKeyPath` (`github.commitAuthor` stays). A config that still has them fails validation with a clear message, as any unknown key does.
- **Owner input** (`src/coordinator.ts`): comments and reviews are the Owner's only if their author is the Owner _and_ their body does not start with the agent note (`isAgentNote` in `src/note.ts`). This is what makes the Owner's own PAT usable.
- **Config** (`src/config.ts`): `sandboxDomains` and `secretPaths` go; the dashboard's Config page loses the "Sandbox domains" row.
- **Browser**: `src/browser.ts`, its doctor check and the smoke runner's `--screenshot` probe go; an Implementer installs a browser when it needs one.
- **Prompts**: the Implementer may install what it needs (with `sudo`); Planner and Reviewer are told not to change the repository; every Role is told to leave GitHub writes to the Coordinator.
- **Doctor**: no bwrap/socat/AppArmor/App checks; checks the `gh` login and identity, push access and check runs per repository.
- **Deploy**: `deploy/create-agent-user.sh` goes; the tools are README prerequisites, and the systemd unit runs as root.
- **Docs**: README, setup, architecture, glossary, pitfalls (sandbox rows removed), specs 001–004 (deprecations).

## Tasks

- [x] Spec 005, deprecations in specs 001–004 (all)
- [x] Runner and prompts: skipped permissions, hooks-only settings, no add-dir, Bypass warning (REQ-005-01)
- [x] `GhToken`, wiring in `index.ts`, config without the App (REQ-005-02)
- [x] Agent note is not Owner input (REQ-005-03)
- [x] Default prompts (REQ-005-04, REQ-002-13, REQ-002-14)
- [x] Doctor (REQ-005-05)
- [x] Systemd unit for root; tools as README prerequisites (REQ-005-06 deprecated)
- [x] Remove `sandboxDomains`, `secretPaths`, browser workarounds, smoke `--screenshot`, dashboard row
- [x] Docs
