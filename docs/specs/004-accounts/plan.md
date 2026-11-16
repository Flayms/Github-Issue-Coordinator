# 004 – Accounts: Plan

## Approach

**One config folder per Account.** Claude Code reads its login, settings and transcripts from `CLAUDE_CONFIG_DIR` (default `~/.claude`). The runner prefixes the tmux window's command with `CLAUDE_CONFIG_DIR=<folder>` for an Account that has a `configDir`; an Account without one runs exactly as before. Hooks, permissions and the sandbox come from the session's `--settings` file, so they don't depend on the folder.

**Config.** Optional `accounts: [{ name, configDir? }]`, in priority order; the default is one Account `default` without `configDir`. Names and folders must be distinct (at most one Account without `configDir`). `configDir` is resolved to an absolute path.

**Pause per Account (REQ-001-17).** The store keeps one pause per Account (table `account_pauses`) instead of the single `pausedUntil` meta key; an existing key becomes the first Account's pause when the Coordinator starts. When a session ends on the usage limit, the Coordinator pauses the Account recorded on the session (sessions from before spec 004: the first Account) for `USAGE_LIMIT_PAUSE_MIN` and logs it. The scheduler still takes one `pausedUntil`: it is set only while every Account is paused, to the end of the earliest pause, so with one Account nothing changes. The cut-off session is queued for resumption at once; it starts as soon as some Account is free.

**Choosing the Account.** The runner picks the Account at every launch (start and resume): the first one whose pause is not in force (`freeAccount` in `src/accounts.ts`), and records it on the session. Choosing in the runner rather than in the scheduler keeps the Planner, Implementer and Reviewer start paths unchanged; the scheduler and the runner use the same store and clock, so the scheduler only starts work when the runner will find a free Account. Deviation from the Assessment, which placed the choice in the scheduler.

**Resuming across Accounts.** `--resume <id>` looks only in `<config folder>/projects/<cwd>/<id>.jsonl`. Before resuming on a different Account than the recorded one, the runner copies `<id>.jsonl` and the `<id>/` folder (subagent transcripts) from the old folder's project folders to the same place in the new one, overwriting an older copy. Chosen over a shared, symlinked `projects/` folder because it needs no setup step.

**Secrets (REQ-004-02).** `secretPaths` lists `.credentials.json` of `~/.claude` and of every Account's folder.

**Doctor (REQ-004-03).** `claude auth status` runs once per Account with its `CLAUDE_CONFIG_DIR`.

## Tasks

- [x] Spec (REQ-004-01 … 03), REQ-001-17 changed
- [x] `src/accounts.ts`: free Account, all-paused end, Account folder, transcript copy (REQ-004-01, REQ-001-17)
- [x] Config: `accounts`, validation, secret paths (REQ-004-01, REQ-004-02)
- [x] Store: Account on sessions, pause per Account, migration of the old pause (REQ-004-01, REQ-001-17)
- [x] Runner: choose the Account, `CLAUDE_CONFIG_DIR`, transcript copy on resume (REQ-004-01, REQ-001-17)
- [x] Coordinator: pause the session's Account, all-paused pause for the scheduler and the Tick snapshot, resume prompt (REQ-001-17)
- [x] Doctor: login per Account (REQ-004-03)
- [x] Docs: setup, glossary, architecture, README, known pitfalls, config example
- [ ] Manual: smoke run with a second config folder, resuming across Accounts and checking Remote Control
