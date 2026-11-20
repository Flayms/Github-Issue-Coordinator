# 006 – Harnesses

**Status:** Implemented

## Goal

The Coordinator ran every agent in Claude Code. The Owner wants other agent CLIs too, so a Role can use another vendor's models and work goes on when one vendor's subscriptions are used up. Each agent CLI is a **Harness**. Claude Code stays fully supported, Remote Control and the Usage quota included. **Codex CLI** is the second Harness. **Antigravity CLI** (`agy`, #177) is the third: it covers Google's Gemini models and has a free tier with a personal Google login, so it is the cheapest Harness to run for real. **Copilot CLI** (#176) is the fourth: many developers already pay for Copilot, and it reaches several vendors' models without a Harness of our own. Each Harness declares its **Harness features**, and a feature one Harness lacks is not taken away from the others.

## Requirements

Existing requirements that say "Claude" or `claude` keep their meaning for the Claude Code Harness: REQ-001-17, REQ-001-18, REQ-001-29, REQ-001-33, REQ-001-67, REQ-003-24, REQ-003-26, REQ-003-37, REQ-003-38, REQ-003-42, REQ-003-43, spec 004 and REQ-005-01/07. Where they talk about the agent generically ("the session", "its turn"), they apply to every Harness. An Account (spec 004) is a login of one Harness.

### REQ-006-01 A Role runs on the Harness of its model

- **Given** a Role whose model belongs to Harness X in the Model catalogue (e.g. `gpt-6.2-sol` → Codex CLI, `opus` → Claude Code), or follows X's model naming
- **When** the Coordinator starts a session for it
- **Then** it launches X's CLI in the tmux window `s<id>` on a free Account of X, with every permission prompt skipped, and records the turn through X's hooks: the session id, the model, the Result validated on the turn's end as before (REQ-001-21)
- **And** the Config page's Model dropdown lists only the models of Harnesses that have an Account, grouped by Harness when there are several
- **And** a config whose Role names a model of a Harness without an Account is invalid

### REQ-006-02 Accounts belong to one Harness

- **Given** Accounts in the config, each with `harness: "claude" | "codex" | "antigravity" | "copilot"` (absent: `claude`) and optionally its own config folder of that Harness
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

### REQ-006-07 A Role runs on Antigravity CLI

- **Given** a Role whose model belongs to Antigravity CLI (e.g. `gemini-4-neon`, or any `gemini-…`) and an Antigravity Account
- **When** the Coordinator starts or resumes its session
- **Then** `agy` runs in the tmux window `s<id>` with every permission prompt skipped and without a folder trust question, and nothing is written into the Worktree or the Account's folder
- **And** its hooks record the conversation id, the model and the transcript; the first model call of a turn counts as its prompt (REQ-001-19), a later one in the same turn does not
- **And** the Result is validated on `Stop`: while it is invalid the turn goes on with the Result instructions, up to 3 times (REQ-001-21)
- **And** a Feedback round resumes the same conversation by its id
- **And** a Role's effort applies unless the model id names its own (e.g. `gemini-4-neon-high`)

### REQ-006-08 Usage limit on Antigravity CLI

- **Given** an Antigravity turn that a quota error ended (`Stop` with `terminationReason: "ERROR"` and a `429` / `RESOURCE_EXHAUSTED` error)
- **When** its `Stop` hook fires
- **Then** the session is marked usage-limited without asking for its Result, and only its Account pauses (REQ-001-17): until the error's `retryDelay` if it gives one, else for the default interval
- **And** any other error is an ordinary `Stop`

### REQ-006-09 One Antigravity Account

- **Given** Antigravity CLI keeps its login per user, with no variable for another config folder
- **When** the config names an Antigravity Account with a `configDir`, or a second Antigravity Account
- **Then** the config is invalid, with a message saying why

### REQ-006-10 A Role runs on Copilot CLI

- **Given** a Role whose model is a Copilot model (`copilot:<id>`, e.g. `copilot:claude-sonnet-5.5`), and an Account with `harness: "copilot"` (its own `COPILOT_HOME`)
- **When** the Coordinator starts its session
- **Then** `copilot` runs interactively with every tool, path and URL allowed and the model `<id>` in the tmux window `s<id>`, its session id is stored, and the Result is validated on its `Stop` hook as before (REQ-001-21)
- **And** the hooks come from the session folder; nothing is written into the Worktree or the Account's folder
- **And** the reason of a blocked `Stop`, which Copilot sends back as the next prompt, does not count as the Owner's message (REQ-001-19)
- **And** Copilot's models are listed apart from the same models on another Harness (e.g. "Claude Sonnet 5.5 (Copilot)"), so a Role's Account and quota are picked deliberately

### REQ-006-11 Feedback resumes the same Copilot session

- **Given** a session with a stored Copilot session id
- **When** a Feedback round, a wake or a resume after a usage limit resumes it
- **Then** that session continues by its id, never through "the latest session" (Worktrees run in parallel, so the latest one is ambiguous)
- **And** on another Account its session folder moves along first (REQ-001-17)

### REQ-006-12 Usage limit on Copilot CLI

- **Given** a Copilot turn whose model call fails on a rate limit or a used-up plan
- **When** Copilot reports the error (it fires no `Stop` then)
- **Then** the turn ends and only that Account is paused, for the default interval, since Copilot gives no reset time there (REQ-001-17)
- **And** any other error leaves the session alone

### REQ-006-13 Setup check for Copilot CLI

- **Given** a Copilot Account
- **When** `bun run doctor` runs
- **Then** it reports the `copilot` version against the one its adapter was checked with, and whether the Account has a login: one stored in its folder, or a token in the environment Copilot reads first
- **And** without one it says how to log in

## Out of scope

- Copilot's Remote Control (`/remote on`), its Usage quota (`/usage`), the reset time of its usage limit and its event log for the Now line: possible later, the matrix marks them missing.
- Gemini CLI: Antigravity CLI replaced it, and it no longer serves free Google logins (since 2026-06-18). Antigravity CLI runs the same models.
- Several Antigravity Accounts (a home folder per Account would also change the agent's git and `gh` setup), Antigravity's Remote Control link, its Now line and its quota: the matrix marks them missing.
- An agent loop of our own for models without a Harness: they are reached through a Harness that offers them.
- Reading Codex's Usage quota (`rate_limits` in its rollout), its exact usage-limit reset time and its rollout for the Now line: possible later, the matrix marks them missing.
- Remote Control for Codex: Codex offers no link into an app.

## Assumptions

- Codex CLI 0.170.0 or newer: hooks from `-c hooks.<Event>=…` overrides with `--dangerously-bypass-hook-trust`, `codex resume <id> <prompt>`, `CODEX_HOME` per login, rollouts under `<CODEX_HOME>/sessions/`. Checked with that version against a fake model server (`docs/harnesses.md`), not yet with a real model.
- Codex fires no Stop hook when the usage limit ends a turn; it writes a `task_complete` event with `codex_error_info: "usage_limit_exceeded"` into the rollout. Its reset time is only in the message text.
- The Codex models in the catalogue are those Codex CLI 0.170.0 lists; a login may offer others, which `config.ts` can still name.
- Antigravity CLI 1.5.12 or newer: hooks from a workspace folder's `.agents/hooks.json` (in trusted folders only; `--settings` refuses `hooks`), `--settings` for session-only settings including `trustedWorkspaces`, `--add-dir`, `--conversation <id>`, `-i <prompt>`, and `agy models` exiting 1 without a login. Checked with that version against a fake Gemini API endpoint (`modelProvider: "gemini"`, `GOOGLE_GEMINI_BASE_URL`), not yet with a Google login.
- A Google login's quota error reaches the `Stop` hook like the Gemini API key's (429, `RESOURCE_EXHAUSTED`, `retryDelay`); seen only with the latter.
- The Antigravity models in the catalogue are the Gemini models `agy models` lists with a Gemini API key, without their effort suffix; a Google login may offer others (e.g. Claude and GPT models), which `config.ts` can name as `agy` does.
- Copilot CLI 1.0.114 or newer: hooks from a plugin (`--plugin-dir`) under Claude Code's event names with Claude Code's payload fields, plus its own `errorOccurred`; `--resume <id>` (an unknown id exits); `COPILOT_HOME` per login; sessions under `<COPILOT_HOME>/session-state/<id>/`; `COPILOT_ALLOW_ALL=true` skips the folder trust dialog. Checked with that version against a fake model server as a BYOK provider, not yet with a Copilot plan.
- Copilot has no login status command; `copilot login` lists the account in `<COPILOT_HOME>/config.json` (`loggedInUsers`), and `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` take precedence over it.
- Copilot reports a rate limit or a used-up plan to `errorOccurred` with `errorContext: "model_call"` and the provider's message (seen with a 429 from the fake server: "rate_limit_error"). GitHub's own messages say "rate limit" or "quota" (`copilot help limits`, `copilot help billing`); not seen with a real plan.
- The Copilot models in the catalogue are from the catalogue bundled with Copilot CLI 1.0.114; which a login may use depends on its plan, and `config.ts` can name any other as `copilot:<id>`.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Result                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| REQ-006-01 | `session runner > Harnesses > REQ-006-01 a Codex model starts codex …`, `… a Claude model still starts claude …`, `… the Codex trust dialog is answered with Enter`; `Codex CLI hooks (recorded payloads) > …` (3); `<Harness> adapter (contract) > REQ-006-01 …`; `Harness of a model > …`; `config > Harnesses > REQ-006-01 a Role whose model's Harness has no Account is a config error`; `Model dropdown per Harness > …` (2); `Codex session through tmux with a fake Harness CLI > …`; `agent note per Harness > REQ-006-01 / REQ-001-29 …`; manual: `bun scripts/smoke-runner.ts --harness codex --fake-model` (Implementer and Reviewer) | pass                  |
| REQ-006-02 | `config > Harnesses > REQ-006-02 …` (2); `session runner > Harnesses > REQ-006-02 …` (2); `scheduler > Harnesses > REQ-006-02 while every Claude Account is paused, work on Codex still starts`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass                  |
| REQ-006-03 | `store > Harness of a session > …` (2); `session runner > Harnesses > REQ-006-03 a resume stays on the session's Harness …`; `<Harness> adapter (contract) > REQ-006-03 …`; `Codex session through tmux with a fake Harness CLI > …`                                                                                                                                                                                                                                                                                                                                                                                                              | pass                  |
| REQ-006-04 | `dashboard view > REQ-006-04 …` (2); `session runner > Harnesses > REQ-006-04 / REQ-001-17 a Codex turn that ended on the usage limit …`; `Codex CLI usage limit (recorded rollout) > …` (3); `<Harness> adapter (contract) > REQ-006-04 transcriptMove …`                                                                                                                                                                                                                                                                                                                                                                                        | pass                  |
| REQ-006-05 | `setup check per Harness > …` (3); `Antigravity CLI launch > REQ-006-05 …`; `<Harness> adapter (contract) > REQ-006-05 …`; manual: `bun run doctor` with a Codex Account                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pass (manual open)    |
| REQ-006-06 | `Harness feature matrix > …` (3); `<Harness> adapter (contract) > REQ-006-06 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass                  |
| REQ-006-07 | `Antigravity CLI adapter (contract) > …` (5); `Antigravity CLI launch > …` (3); `Antigravity CLI hooks (recorded payloads) > REQ-006-07 …` (4); `Harness of a model > REQ-006-07 …`; `session runner > Harnesses > REQ-006-07 a Gemini model starts agy …`; `Harness sessions through tmux with a fake Harness CLI > REQ-006-07 …`; `Model dropdown per Harness > REQ-006-07 …`; manual: `bun scripts/smoke-runner.ts --harness antigravity --fake-model` (Implementer and Reviewer) with `agy` 1.5.12                                                                                                                                            | pass                  |
| REQ-006-08 | `Antigravity CLI hooks (recorded payloads) > REQ-006-08 …` (2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass                  |
| REQ-006-09 | `config > Harnesses > REQ-006-09 Antigravity CLI has one Account, in its default folder`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pass                  |
| REQ-006-10 | `Copilot CLI (spec 006, #176) > REQ-006-10 …` (2); `Copilot CLI hooks (recorded payloads) > REQ-006-10 …` (5); `<Harness> adapter (contract) > …` for Copilot CLI; `Harness of a model > REQ-006-10 …`; `Model catalogue > REQ-006-10 …`; `agent note per Harness > REQ-006-10 …`; `Harness sessions through tmux with a fake Harness CLI > REQ-006-10 / REQ-006-11 …`; manual: `bun scripts/smoke-runner.ts --harness copilot --fake-model` (Implementer and Reviewer)                                                                                                                                                                           | pass                  |
| REQ-006-11 | `Copilot CLI (spec 006, #176) > REQ-006-11 …` (2); `Harness sessions through tmux with a fake Harness CLI > REQ-006-10 / REQ-006-11 …`; manual: smoke run above (same session id after the resume)                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass                  |
| REQ-006-12 | `Copilot CLI hooks (recorded payloads) > REQ-006-12 …` (3); manual: real `copilot` against a fake server answering 429 fired `errorOccurred` and no `Stop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass (real plan open) |
| REQ-006-13 | `setup check for Copilot CLI > …` (2); `Copilot CLI login check > …` (3); manual: `bun scripts/smoke-runner.ts --harness copilot` skips without a login                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                  |
