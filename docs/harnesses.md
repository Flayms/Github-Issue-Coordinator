# Harnesses

A **Harness** is the agent CLI a session runs in (spec 006). The Coordinator supports **Claude Code**, **Codex CLI**
and **Copilot CLI**. Each Role runs on the Harness of its model: `opus` or `claude-opus-5-5` on Claude Code,
`gpt-6.2-sol` on Codex CLI, `copilot:claude-sonnet-5.5` or `copilot:gpt-6.1-sol` on Copilot CLI (REQ-006-01,
REQ-006-07). A resumed session stays on the Harness it started on (REQ-006-03).

## Feature matrix

Every Harness has the **core** features. The others are **Harness features** a Harness may lack: the dashboard and the
scheduler use them wherever a Harness has them, and fall back quietly where it doesn't (REQ-006-04). Nothing is cut
down to what every Harness can do. The table is built from what each adapter in `src/harness/` declares, and
`bun test` fails when the two differ (REQ-006-06), so adding a Harness or a feature updates this table in the same PR.

<!-- feature-matrix:start (generated from src/harness; bun test checks it) -->
| Feature                                  | Claude Code                         | Codex CLI                                       | Copilot CLI                     |
| ---------------------------------------- | ----------------------------------- | ----------------------------------------------- | ------------------------------- |
| Start in tmux, skip permissions (core)   | ✅ `--dangerously-skip-permissions` | ✅ `--dangerously-bypass-approvals-and-sandbox` | ✅ `--allow-all`                |
| Resume by session id (core)              | ✅ `--resume`                       | ✅ `codex resume`                               | ✅ `--resume <id>`              |
| Turn-end hook (Result validation) (core) | ✅ `Stop`                           | ✅ `Stop`                                       | ✅ `Stop` (`agentStop`)         |
| Login check (`bun run doctor`) (core)    | ✅ `claude auth status`             | ✅ `codex login status`                         | ✅ `config.json` of the Account |
| Remote Control / Open chat               | ✅ `--remote-control`               | ❌                                              | ❌                              |
| Now line from the transcript             | ✅ transcript                       | ❌                                              | ❌                              |
| Usage quota meters                       | ✅ status line                      | ❌                                              | ❌                              |
| Usage limit detected                     | ✅ `StopFailure`                    | ✅ rollout `task_complete` error                | ✅ `errorOccurred`              |
| Usage limit with reset time              | ✅ transcript                       | ❌                                              | ❌                              |
| Transcript move on Account switch        | ✅ copied                           | ✅ rollout copied                               | ✅ `session-state/<id>/` copied |
| Minimum CLI version                      | `claude` 2.1.0                      | `codex` 0.170.0                                 | `copilot` 1.0.114               |

- **Codex CLI, Remote Control / Open chat:** Codex has no link into a phone or web app; attach to tmux instead.
- **Codex CLI, Now line from the transcript:** the rollout format differs from Claude's transcript; not read yet.
- **Codex CLI, Usage quota meters:** Codex writes `rate_limits` into its rollout; not read yet.
- **Codex CLI, Usage limit with reset time:** only in the message text; the Account pauses for the default interval.
- **Copilot CLI, Remote Control / Open chat:** Copilot's `/remote on` could link a session to GitHub; not wired up yet.
- **Copilot CLI, Now line from the transcript:** the session's event log differs from Claude's transcript; not read yet.
- **Copilot CLI, Usage quota meters:** Copilot shows it only in `/usage`; not read yet.
- **Copilot CLI, Usage limit with reset time:** not in the hook's payload; the Account pauses for the default interval.
<!-- feature-matrix:end -->

To regenerate the block: `bun -e 'import { featureMatrix } from "./src/harness/matrix.ts"; console.log(featureMatrix())'`.

## Setting up Codex CLI

1. Install it: `npm i -g @openai/codex` (or `bun i -g @openai/codex`), version 0.170.0 or newer.
2. Log in once per Account, each in its own `CODEX_HOME`: `CODEX_HOME=~/.codex-work codex login` (a ChatGPT
   subscription), or `codex login --with-api-key` (pay per use).
3. Add the Account to `config.ts` with `harness: "codex"`:

   ```ts
   accounts: [
     { name: "claude" },
     { name: "gpt", harness: "codex", configDir: "/home/agent/.codex-work" },
   ],
   ```

4. Pick a Codex model for a Role, in `config.ts` or on the Config page, whose Model dropdown now lists Codex's models.
   A Role whose model's Harness has no Account is a config error.
5. `bun run doctor` checks the `codex` CLI, its version and each Codex Account's login (REQ-006-05).

How a Codex session runs:

- `codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --model <m>`, plus
  `-c model_reasoning_effort="<effort>"` and the hooks as `-c hooks.<Event>=…` overrides. Nothing is written into
  the Account's `CODEX_HOME` except Codex's own folder trust, answered once per folder.
- Hooks: `SessionStart` (session id, model, rollout path), `UserPromptSubmit`, `Stop` (Result validation, blocked
  up to 3 times like Claude's) and `SessionEnd`.
- Resume: `codex resume <id> <prompt>`. On another Account the rollout file is copied to the same place in its
  `CODEX_HOME` first.
- **Usage limit:** Codex fires no `Stop` when the limit ends a turn. The Coordinator finds the turn's
  `task_complete` event with `usage_limit_exceeded` in the rollout every few seconds and pauses the Account for the
  default interval (REQ-001-17), since the reset time is only in the message text.

## Setting up Copilot CLI

1. Install it, version 1.0.114 or newer: `npm i -g @github/copilot`, or the standalone binary (see GitHub's docs).
   Installed with `bun i -g`, the `copilot` on the PATH is a Node script: without Node, copy the native binary
   (`…/node_modules/@github/copilot-linux-x64/copilot`) onto the PATH instead.
2. Log in once per Account, each in its own `COPILOT_HOME`: `COPILOT_HOME=~/.copilot-work copilot login`. On a server
   without a keyring, `copilot login` asks to store the token in that folder's `config.json`; say yes. A fine-grained
   PAT with the **Copilot Requests** permission works too (`copilot login --with-token`). Classic `ghp_` tokens don't.
3. Add the Account to `config.ts` with `harness: "copilot"`:

   ```ts
   accounts: [
     { name: "claude" },
     { name: "copilot", harness: "copilot", configDir: "/home/agent/.copilot-work" },
   ],
   ```

4. Pick a Copilot model for a Role. Copilot's models carry a `copilot:` prefix, e.g. `copilot:claude-sonnet-5.5` or
   `copilot:auto`, so a Role on "Claude Sonnet 5.5 (Copilot)" runs on the Copilot Account and its quota, never on a
   Claude Code Account. `config.ts` may name any model Copilot offers as `copilot:<id>`; the Config page lists the ones
   bundled with Copilot CLI 1.0.114, and which of them a login may use depends on its plan.
5. `bun run doctor` checks the `copilot` CLI, its version and each Copilot Account's login. Copilot has no command
   that reports the login, so the check reads `loggedInUsers` from the Account's `config.json`, or a token in
   `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` (REQ-006-10).

How a Copilot session runs:

- `COPILOT_ALLOW_ALL=true copilot --plugin-dir <session>/copilot-plugin --allow-all --model <m>` plus
  `--reasoning-effort <effort>` and `-i <prompt>` (interactive, starting with the prompt). `COPILOT_ALLOW_ALL=true`
  also trusts the working folder, so no trust dialog comes up.
- Hooks: a plugin in the session folder, so nothing is written into the Worktree (no `.github/hooks/`) or the
  Account's `COPILOT_HOME`. Copilot runs hooks under Claude Code's names with Claude Code's payload fields:
  `SessionStart` (session id; no model or transcript path), `UserPromptSubmit`, `Stop` (Result validation, blocked up
  to 3 times) and `SessionEnd`. A blocked `Stop`'s reason comes back as the next prompt, firing `UserPromptSubmit`;
  the hook recognises it, so it doesn't count as the Owner's message.
- Resume: `copilot --resume <id> -i <prompt>`, never `--continue` (the latest session is ambiguous across Worktrees).
  An unknown id ends the CLI instead of starting a fresh session. On another Account the session's
  `session-state/<id>/` folder is copied first.
- **Usage limit:** a rate limit or a used-up plan ends the turn without `Stop`. Copilot fires its own
  `errorOccurred` hook then (`errorContext: "model_call"`, the provider's message in `error.message`), and the
  Coordinator pauses the Account for the default interval (REQ-006-09), since the payload has no reset time.

## Testing without a subscription

- **Recorded payloads:** `test/fixtures/codex/` holds hook payloads and a rollout recorded from Codex CLI 0.170.0,
  `test/fixtures/copilot/` the hook payloads and a `config.json` recorded from Copilot CLI 1.0.114.
- **Fake Harness CLI:** `test/support/fake-harness.ts` takes Codex's or Copilot's command line, fires its hooks and
  writes a Result, so `bun test` runs a Codex and a Copilot session through real tmux and the real hook script.
- **Contract suite:** `test/harness.test.ts` runs the core cases against every adapter and the optional ones only
  where the adapter declares the feature. A new Harness has to pass it.
- **Real Codex, fake model:** `bun scripts/smoke-runner.ts --harness codex --fake-model` runs the real `codex`
  binary against a local fake model server (`scripts/fake-model-server.ts`), with no login and no cost. This is how
  the Codex column above was checked: hooks, the `Stop` block, resume with a prompt, the rollout copy and the usage
  limit's `task_complete` error.
- **Real Codex, real model:** `bun scripts/smoke-runner.ts --harness codex --model gpt-5.5` uses the default
  `CODEX_HOME`'s login (a ChatGPT plan, or an `OPENAI_API_KEY` for a few cents per run).
- **Real Copilot, fake model:** `bun scripts/smoke-runner.ts --harness copilot --fake-model` runs the real `copilot`
  against the same fake server as its own model provider (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_OFFLINE=true`), with
  no login. This is how the Copilot column was checked: the plugin's hooks and their payloads, the `Stop` block and
  its prompt, resume by id, a session folder copied to another `COPILOT_HOME`, and `errorOccurred` on a 429 from the
  model.
- **Real Copilot, real model:** `bun scripts/smoke-runner.ts --harness copilot` uses the default `~/.copilot`'s login
  and `copilot:claude-haiku-5.5` (pass `--model copilot:<id>` for another); it skips when there is no login.

## Other Harnesses and models

- **Gemini CLI** is a follow-up: it gets an adapter, a column in the matrix and the contract suite.
- **Models without a Harness of their own** are reached through one that offers them (Copilot CLI for several
  vendors, or Claude Code against an Anthropic-compatible gateway). There is no agent loop of our own.
