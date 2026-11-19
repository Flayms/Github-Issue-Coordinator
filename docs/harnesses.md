# Harnesses

A **Harness** is the agent CLI a session runs in (spec 006). The Coordinator supports **Claude Code** and **Codex CLI**.
Each Role runs on the Harness of its model: `opus` or `claude-opus-5-5` on Claude Code, `gpt-6.2-sol` on Codex CLI
(REQ-006-01). A resumed session stays on the Harness it started on (REQ-006-03).

## Feature matrix

Every Harness has the **core** features. The others are **Harness features** a Harness may lack: the dashboard and the
scheduler use them wherever a Harness has them, and fall back quietly where it doesn't (REQ-006-04). Nothing is cut
down to what every Harness can do. The table is built from what each adapter in `src/harness/` declares, and
`bun test` fails when the two differ (REQ-006-06), so adding a Harness or a feature updates this table in the same PR.

<!-- feature-matrix:start (generated from src/harness; bun test checks it) -->
| Feature                                  | Claude Code                         | Codex CLI                                       |
| ---------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| Start in tmux, skip permissions (core)   | ✅ `--dangerously-skip-permissions` | ✅ `--dangerously-bypass-approvals-and-sandbox` |
| Resume by session id (core)              | ✅ `--resume`                       | ✅ `codex resume`                               |
| Turn-end hook (Result validation) (core) | ✅ `Stop`                           | ✅ `Stop`                                       |
| Login check (`bun run doctor`) (core)    | ✅ `claude auth status`             | ✅ `codex login status`                         |
| Remote Control / Open chat               | ✅ `--remote-control`               | ❌                                              |
| Now line from the transcript             | ✅ transcript                       | ❌                                              |
| Usage quota meters                       | ✅ status line                      | ❌                                              |
| Usage limit detected                     | ✅ `StopFailure`                    | ✅ rollout `task_complete` error                |
| Usage limit with reset time              | ✅ transcript                       | ❌                                              |
| Transcript move on Account switch        | ✅ copied                           | ✅ rollout copied                               |
| Minimum CLI version                      | `claude` 2.1.0                      | `codex` 0.170.0                                 |

- **Codex CLI, Remote Control / Open chat:** Codex has no link into a phone or web app; attach to tmux instead.
- **Codex CLI, Now line from the transcript:** the rollout format differs from Claude's transcript; not read yet.
- **Codex CLI, Usage quota meters:** Codex writes `rate_limits` into its rollout; not read yet.
- **Codex CLI, Usage limit with reset time:** only in the message text; the Account pauses for the default interval.
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

## Testing without a subscription

- **Recorded payloads:** `test/fixtures/codex/` holds hook payloads and a rollout recorded from Codex CLI 0.170.0.
- **Fake Harness CLI:** `test/support/fake-harness.ts` takes Codex's command line, fires its hooks and writes a Result,
  so `bun test` runs a Codex session through real tmux and the real hook script.
- **Contract suite:** `test/harness.test.ts` runs the core cases against every adapter and the optional ones only
  where the adapter declares the feature. A new Harness has to pass it.
- **Real Codex, fake model:** `bun scripts/smoke-runner.ts --harness codex --fake-model` runs the real `codex`
  binary against a local fake model server (`scripts/fake-model-server.ts`), with no login and no cost. This is how
  the Codex column above was checked: hooks, the `Stop` block, resume with a prompt, the rollout copy and the usage
  limit's `task_complete` error.
- **Real Codex, real model:** `bun scripts/smoke-runner.ts --harness codex --model gpt-5.5` uses the default
  `CODEX_HOME`'s login (a ChatGPT plan, or an `OPENAI_API_KEY` for a few cents per run).

## Other Harnesses and models

- **Copilot CLI and Gemini CLI** are follow-ups: each gets an adapter, a column in the matrix and the contract suite.
- **Models without a Harness of their own** are reached through one that offers them (e.g. Copilot CLI for several
  vendors, or Claude Code against an Anthropic-compatible gateway). There is no agent loop of our own.
