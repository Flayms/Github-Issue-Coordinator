# 004 – Accounts

**Status:** Implemented

## Goal

The Owner may have more than one Claude subscription. When the one the Coordinator uses hits its usage limit, work should go on with another one instead of waiting for the reset. Each subscription is an **Account**: a Claude login in its own config folder. A setup with one subscription keeps working as before, without any config change.

## Requirements

REQ-001-17 (usage limit per Account) is part of this feature and stays in spec 001.

### REQ-004-01 Sessions run on the first free Account

- **Given** `accounts` in the config, a list of Accounts in priority order, each with a name and optionally its own Claude config folder (without `accounts` there is one implicit Account: Claude's default folder `~/.claude`)
- **When** the Coordinator starts or resumes a session
- **Then** the session runs on the first Account in config order that isn't paused by a usage limit (REQ-001-17), logged in with that Account's config folder
- **And** the Account is recorded on the session
- **And** a resumed session that last ran on another Account keeps its conversation

### REQ-004-02 Agents can't read any Account's login

- **Given** one or more Accounts
- **When** any agent session runs
- **Then** reading any Account's Claude login credentials, with a file tool or a shell command, is denied (extends REQ-001-26)

### REQ-004-03 The setup check covers every Account

- **Given** one or more Accounts
- **When** `bun run doctor` runs
- **Then** it reports for each Account whether it is logged in and with which subscription type

## Out of scope

- Switching before a limit is hit (checking the remaining usage before a session starts): Claude Code offers no stable usage API, and the trigger is the detected limit.
- Spreading work across Accounts (round-robin): it drains every subscription at once and moves Remote Control sessions between claude.ai accounts.
- Showing per-Account pauses on the dashboard; it shows the pause only while every Account is paused, as before.

## Assumptions

- Each Account is logged in once with the interactive login in its own config folder (`CLAUDE_CONFIG_DIR=<folder> claude` → `/login`); `claude setup-token` does not work with Remote Control.
- A session shows up in Remote Control only in the claude.ai account it runs on, so the Owner switches accounts in the Claude app to follow a session on a fallback Account.
- Claude Code keeps a session's transcript in `<config folder>/projects/` and `--resume` finds it only there; the Coordinator copies it along when a session moves to another Account. Resuming a copied transcript on another login is not verified end to end yet (`docs/known-pitfalls.md`).
- With a config folder set, Claude also keeps its global settings (`.claude.json`: folder trust, onboarding) in that folder; the trust dialog is answered as before.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Result             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| REQ-004-01 | `config > REQ-004-01 without accounts there is one implicit Account …`; `config > REQ-004-01 Accounts need distinct names and folders …`; `Accounts > REQ-004-01 the first Account in config order that isn't paused is used`; `Accounts > REQ-004-01 an Account without configDir is Claude's default folder`; `store > REQ-004-01 records the Account a session runs on`; `session runner > Accounts > REQ-004-01 a session starts on the first Account …`; `session runner > Accounts > REQ-004-01 / REQ-001-17 while the first Account is paused, sessions start on the next one …`; `session runner > Accounts > REQ-001-17 a session resumed on another Account takes its transcript along`; `reconcile loop > REQ-001-17 / REQ-004-01 a usage limit pauses only its Account …`; manual (not run yet): smoke run resuming a session started on one Account on another and seeing it in Remote Control | pass (manual open) |
| REQ-004-02 | `config > REQ-004-02 agents are denied every Account's login`; `session runner > REQ-001-26 every Role is denied reading the Coordinator's secrets …` (the runner denies whatever `secretPaths` returns)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass               |
| REQ-004-03 | manual: `bun run doctor` (talks to the real `claude`; not run in the Implementer's sandbox)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | open               |
