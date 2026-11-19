# 006 – Harnesses

**Status:** Implemented

## Goal

The Coordinator ran every agent in Claude Code. The Owner wants other agent CLIs too, so a Role can use another vendor's models and work goes on when one vendor's subscriptions are used up. Each agent CLI is a **Harness**. Claude Code stays fully supported, Remote Control and the Usage quota included. **Codex CLI** is the second Harness. Each Harness declares its **Harness features**, and a feature one Harness lacks is not taken away from the others.

## Requirements

Existing requirements that say "Claude" or `claude` keep their meaning for the Claude Code Harness: REQ-001-17, REQ-001-18, REQ-001-29, REQ-001-33, REQ-001-67, REQ-003-24, REQ-003-26, REQ-003-37, REQ-003-38, REQ-003-42, REQ-003-43, spec 004 and REQ-005-01/07. Where they talk about the agent generically ("the session", "its turn"), they apply to every Harness. An Account (spec 004) is a login of one Harness.

### REQ-006-01 A Role runs on the Harness of its model

- **Given** a Role whose model belongs to Harness X in the Model catalogue (e.g. `gpt-6.2-sol` → Codex CLI, `opus` → Claude Code), or follows X's model naming
- **When** the Coordinator starts a session for it
- **Then** it launches X's CLI in the tmux window `s<id>` on a free Account of X, with every permission prompt skipped, and records the turn through X's hooks: the session id, the model, the Result validated on the turn's end as before (REQ-001-21)
- **And** the Config page's Model dropdown lists only the models of Harnesses that have an Account, grouped by Harness when there are several
- **And** a config whose Role names a model of a Harness without an Account is invalid

### REQ-006-02 Accounts belong to one Harness

- **Given** Accounts in the config, each with `harness: "claude" | "codex"` (absent: `claude`) and optionally its own config folder of that Harness
- **When** work is scheduled
- **Then** a session runs only on Accounts of its Harness, the first free one in config order (REQ-004-01)
- **And** a usage limit pauses that Account only; while every Account of a Harness is paused, only that Harness's work waits

### REQ-006-03 A resume stays on its Harness

- **Given** a session started on Harness X
- **When** it is resumed (a Feedback round, a wake, a resume after a usage limit)
- **Then** it resumes on X with X's session id, even if its Role's model has since moved to another Harness; the change applies to new sessions
- **And** sessions stored before this spec ran on Claude Code

### REQ-006-04 Harness features are used where a Harness has them

- **Given** a Harness that declares an optional Harness feature (e.g. Claude Code: Remote Control, the Now line, the Usage quota)
- **When** the dashboard shows its sessions and Accounts, or the Coordinator looks for a turn's end
- **Then** the feature works as before for that Harness
- **And** for a Harness without it the dashboard shows no Open chat link and no Now line, and its Account's Usage quota shows "no report" (REQ-003-38), never an error
- **And** a turn the Harness ends without its turn-end hook (Codex on the usage limit) is still found and pauses the Account (REQ-001-17)

### REQ-006-05 The setup check covers each Harness in use

- **Given** an Account of Harness X
- **When** `bun run doctor` runs
- **Then** it checks that X's CLI is installed, warns below the version its adapter was checked with, and reports each of X's Accounts' login
- **And** a Harness without an Account is not checked

### REQ-006-06 The Harness feature matrix matches the code

- **Given** each Harness adapter declares which core and optional Harness features it has
- **When** `bun test` runs
- **Then** it fails if the feature matrix in `docs/harnesses.md` differs from those declarations, so adding a Harness or a feature updates the table in the same change
- **And** each missing feature says what the Owner loses

## Out of scope

- Copilot CLI and Gemini CLI: follow-up issues, each a new adapter, a matrix column and the contract suite.
- An agent loop of our own for models without a Harness: they are reached through a Harness that offers them.
- Reading Codex's Usage quota (`rate_limits` in its rollout), its exact usage-limit reset time and its rollout for the Now line: possible later, the matrix marks them missing.
- Remote Control for Codex: Codex offers no link into an app.

## Assumptions

- Codex CLI 0.170.0 or newer: hooks from `-c hooks.<Event>=…` overrides with `--dangerously-bypass-hook-trust`, `codex resume <id> <prompt>`, `CODEX_HOME` per login, rollouts under `<CODEX_HOME>/sessions/`. Checked with that version against a fake model server (`docs/harnesses.md`), not yet with a real model.
- Codex fires no Stop hook when the usage limit ends a turn; it writes a `task_complete` event with `codex_error_info: "usage_limit_exceeded"` into the rollout. Its reset time is only in the message text.
- The Codex models in the catalogue are those Codex CLI 0.170.0 lists; a login may offer others, which `config.ts` can still name.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Result             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| REQ-006-01 | `session runner > Harnesses > REQ-006-01 a Codex model starts codex …`, `… a Claude model still starts claude …`, `… the Codex trust dialog is answered with Enter`; `Codex CLI hooks (recorded payloads) > …` (3); `<Harness> adapter (contract) > REQ-006-01 …`; `Harness of a model > …`; `config > Harnesses > REQ-006-01 a Role whose model's Harness has no Account is a config error`; `Model dropdown per Harness > …` (2); `Codex session through tmux with a fake Harness CLI > …`; `agent note per Harness > REQ-006-01 / REQ-001-29 …`; manual: `bun scripts/smoke-runner.ts --harness codex --fake-model` (Implementer and Reviewer) | pass               |
| REQ-006-02 | `config > Harnesses > REQ-006-02 …` (2); `session runner > Harnesses > REQ-006-02 …` (2); `scheduler > Harnesses > REQ-006-02 while every Claude Account is paused, work on Codex still starts`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass               |
| REQ-006-03 | `store > Harness of a session > …` (2); `session runner > Harnesses > REQ-006-03 a resume stays on the session's Harness …`; `<Harness> adapter (contract) > REQ-006-03 …`; `Codex session through tmux with a fake Harness CLI > …`                                                                                                                                                                                                                                                                                                                                                                                                              | pass               |
| REQ-006-04 | `dashboard view > REQ-006-04 …` (2); `session runner > Harnesses > REQ-006-04 / REQ-001-17 a Codex turn that ended on the usage limit …`; `Codex CLI usage limit (recorded rollout) > …` (3); `<Harness> adapter (contract) > REQ-006-04 transcriptMove …`                                                                                                                                                                                                                                                                                                                                                                                        | pass               |
| REQ-006-05 | `setup check per Harness > …` (2); `<Harness> adapter (contract) > REQ-006-05 …`; manual: `bun run doctor` with a Codex Account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass (manual open) |
| REQ-006-06 | `Harness feature matrix > …` (3); `<Harness> adapter (contract) > REQ-006-06 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass               |
