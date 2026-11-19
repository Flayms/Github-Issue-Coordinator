# Harnesses

A **Harness** is the agent CLI a session runs in (spec 006). The Coordinator supports **Claude Code**, **Codex CLI**
and **Antigravity CLI**. Each Role runs on the Harness of its model: `opus` or `claude-opus-5-5` on Claude Code,
`gpt-6.2-sol` on Codex CLI, `gemini-4-neon` on Antigravity CLI (REQ-006-01, REQ-006-07). A resumed session stays on the
Harness it started on (REQ-006-03).

## Feature matrix

Every Harness has the **core** features. The others are **Harness features** a Harness may lack: the dashboard and the
scheduler use them wherever a Harness has them, and fall back quietly where it doesn't (REQ-006-04). Nothing is cut
down to what every Harness can do. The table is built from what each adapter in `src/harness/` declares, and
`bun test` fails when the two differ (REQ-006-06), so adding a Harness or a feature updates this table in the same PR.

<!-- feature-matrix:start (generated from src/harness; bun test checks it) -->
| Feature                                  | Claude Code                         | Codex CLI                                       | Antigravity CLI                     |
| ---------------------------------------- | ----------------------------------- | ----------------------------------------------- | ----------------------------------- |
| Start in tmux, skip permissions (core)   | ✅ `--dangerously-skip-permissions` | ✅ `--dangerously-bypass-approvals-and-sandbox` | ✅ `--dangerously-skip-permissions` |
| Resume by session id (core)              | ✅ `--resume`                       | ✅ `codex resume`                               | ✅ `--conversation`                 |
| Turn-end hook (Result validation) (core) | ✅ `Stop`                           | ✅ `Stop`                                       | ✅ `Stop`                           |
| Login check (`bun run doctor`) (core)    | ✅ `claude auth status`             | ✅ `codex login status`                         | ✅ `agy models`                     |
| Remote Control / Open chat               | ✅ `--remote-control`               | ❌                                              | ❌                                  |
| Now line from the transcript             | ✅ transcript                       | ❌                                              | ❌                                  |
| Usage quota meters                       | ✅ status line                      | ❌                                              | ❌                                  |
| Usage limit detected                     | ✅ `StopFailure`                    | ✅ rollout `task_complete` error                | ✅ `Stop` error                     |
| Usage limit with reset time              | ✅ transcript                       | ❌                                              | ✅ `retryDelay` of the error        |
| Transcript move on Account switch        | ✅ copied                           | ✅ rollout copied                               | ❌                                  |
| Minimum CLI version                      | `claude` 2.1.0                      | `codex` 0.170.0                                 | `agy` 1.5.12                        |

- **Codex CLI, Remote Control / Open chat:** Codex has no link into a phone or web app; attach to tmux instead.
- **Codex CLI, Now line from the transcript:** the rollout format differs from Claude's transcript; not read yet.
- **Codex CLI, Usage quota meters:** Codex writes `rate_limits` into its rollout; not read yet.
- **Codex CLI, Usage limit with reset time:** only in the message text; the Account pauses for the default interval.
- **Antigravity CLI, Remote Control / Open chat:** `agy --remote-control` exists, but its link isn't read yet; attach to tmux instead.
- **Antigravity CLI, Now line from the transcript:** its transcript format differs from Claude's; not read yet.
- **Antigravity CLI, Usage quota meters:** Antigravity shows the quota only in its `/usage` panel.
- **Antigravity CLI, Transcript move on Account switch:** one Account only: the login is per user (keyring or a file in the home folder), with no folder variable.
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

## Setting up Antigravity CLI

Google's Antigravity CLI (`agy`) replaced Gemini CLI, and it still works with a free personal Google login.

1. Install it: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (into `~/.local/bin`), version 1.5.12 or
   newer.
2. Run `agy` once in a terminal of the Coordinator's user and sign in. On a server it prints a URL to open on your own
   machine and asks for the code. Finish its first-run screens (color scheme, terms) there too.
3. Add the Account to `config.ts` with `harness: "antigravity"` and no `configDir`:

   ```ts
   accounts: [
     { name: "claude" },
     { name: "gemini", harness: "antigravity" },
   ],
   ```

   Antigravity keeps its login per user (the OS keyring, or a file in the home folder on a server) and has no
   variable for another folder, so it supports **one Account** (REQ-006-09). A `configDir`, or a second Antigravity
   Account, is a config error.

4. Pick a Gemini model for a Role, e.g. `gemini-4-neon`. The catalogue lists the models without their effort suffix,
   so the Role's effort applies; a model id with its own suffix (`gemini-4-neon-high`) wins, since `agy` refuses both.
5. `bun run doctor` checks `agy`, its version, and the login with `agy models` (REQ-006-05).

How an Antigravity session runs:

- The command line:
  `agy --settings <session>/agy-settings.json --add-dir <session> --dangerously-skip-permissions --model <m> [--effort <e>] -i <prompt>`.
- **Hooks:** `agy` loads hooks only from a workspace folder's `.agents/hooks.json` (or the user's global one), and
  `--settings` refuses a `hooks` key. So the session folder is added as a second workspace folder with its own
  `.agents/hooks.json`: `SessionStart`, `PreInvocation` and `Stop`. Nothing is written into the Worktree or `~/.gemini`.
- **Settings for the session only** (never saved): `trustedWorkspaces` with the Worktree and the session folder (workspace
  hooks load only in trusted folders, and it skips the trust question), `artifactReviewPolicy: "always-proceed"` (no wait
  for a plan review), `allowNonWorkspaceAccess` and no feedback survey.
- **Hook payloads** are camelCase (`conversationId`, `modelName`, `transcriptPath`) and have no `UserPromptSubmit`.
  `src/harness/antigravity.ts` translates them for `src/hook.ts`: the first model call of a turn (`PreInvocation` with
  `invocationNum: 0`) counts as the prompt, and the Stop block answers `{"decision": "continue"}`, which re-enters the
  loop (`"block"` would let it stop).
- **Resume:** `agy --conversation <id>`. It fires no `SessionStart` then; the id is already stored.
- **Usage limit:** `Stop` fires with `terminationReason: "ERROR"` and the API error in `error`
  (`Error 429 … RESOURCE_EXHAUSTED … retryDelay:<seconds>s`). The Account pauses until then, or for the default
  interval when no delay is given (REQ-006-08). Seen with a Gemini API key against a fake endpoint; a Google login's quota error is assumed to
  look the same.

## Testing without a subscription

- **Recorded payloads:** `test/fixtures/codex/` holds hook payloads and a rollout recorded from Codex CLI 0.170.0;
  `test/fixtures/antigravity/` hook payloads recorded from Antigravity CLI 1.5.12, a quota error among them.
- **Fake Harness CLI:** `test/support/fake-harness.ts` takes Codex's or Antigravity's command line, fires its hooks and
  writes a Result, so `bun test` runs a Codex and an Antigravity session through real tmux and the real hook script.
- **Contract suite:** `test/harness.test.ts` runs the core cases against every adapter and the optional ones only
  where the adapter declares the feature. A new Harness has to pass it.
- **Real Codex, fake model:** `bun scripts/smoke-runner.ts --harness codex --fake-model` runs the real `codex`
  binary against a local fake model server (`scripts/fake-model-server.ts`), with no login and no cost. This is how
  the Codex column above was checked: hooks, the `Stop` block, resume with a prompt, the rollout copy and the usage
  limit's `task_complete` error.
- **Real Codex, real model:** `bun scripts/smoke-runner.ts --harness codex --model gpt-5.5` uses the default
  `CODEX_HOME`'s login (a ChatGPT plan, or an `OPENAI_API_KEY` for a few cents per run).
- **Real Antigravity, fake model:** `bun scripts/smoke-runner.ts --harness antigravity --fake-model` runs the real `agy`
  with a home folder of its own, whose settings send model requests to the Gemini API (`modelProvider: "gemini"`,
  `GEMINI_API_KEY`), here the fake server through `GOOGLE_GEMINI_BASE_URL`. No login, no cost. This checked hooks, the
  Result, resume by conversation id and the session settings; the Stop `continue` and the quota error were checked by
  hand the same way.
- **Real Antigravity, real model:** `bun scripts/smoke-runner.ts --harness antigravity` uses the user's Google login
  (the free tier is enough) and skips when there is none.

## Other Harnesses and models

- **Copilot CLI** is a follow-up: it gets an adapter, a column in the matrix and the contract suite.
- **Gemini CLI** is not supported: Antigravity CLI replaced it, and since 2026-06-18 it no longer serves free or Google
  AI Pro/Ultra logins. Antigravity CLI runs the same Gemini models.
- **Models without a Harness of their own** are reached through one that offers them (e.g. Copilot CLI for several
  vendors, or Claude Code against an Anthropic-compatible gateway). There is no agent loop of our own.
