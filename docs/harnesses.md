# Harnesses

A **Harness** is the agent CLI a session runs in (spec 006). The Coordinator supports **Claude Code**, **Codex CLI**,
**Antigravity CLI**, **Copilot CLI** and **OpenCode**. Each Role runs on the Harness of its model: `opus` or
`claude-opus-5-5` on Claude Code, `gpt-6.2-sol` on Codex CLI, `gemini-4-neon` on Antigravity CLI,
`copilot:claude-sonnet-5.5` or `copilot:gpt-6.1-sol` on Copilot CLI, `opencode:opencode/big-pickle` on OpenCode
(REQ-006-01, REQ-006-07, REQ-006-10, REQ-006-14). A resumed session stays on the Harness it started on (REQ-006-03).

## Feature matrix

Every Harness has the **core** features. The others are **Harness features** a Harness may lack: the dashboard and the
scheduler use them wherever a Harness has them, and fall back quietly where it doesn't (REQ-006-04). Nothing is cut
down to what every Harness can do. The table is built from what each adapter in `src/harness/` declares, and
`bun test` fails when the two differ (REQ-006-06), so adding a Harness or a feature updates this table in the same PR.

<!-- feature-matrix:start (generated from src/harness; bun test checks it) -->
| Feature                                  | Claude Code                         | Codex CLI                                       | Antigravity CLI                     | Copilot CLI                     | OpenCode                         |
| ---------------------------------------- | ----------------------------------- | ----------------------------------------------- | ----------------------------------- | ------------------------------- | -------------------------------- |
| Start in tmux, skip permissions (core)   | ✅ `--dangerously-skip-permissions` | ✅ `--dangerously-bypass-approvals-and-sandbox` | ✅ `--dangerously-skip-permissions` | ✅ `--allow-all`                | ✅ `--auto`, `permission: allow` |
| Resume by session id (core)              | ✅ `--resume`                       | ✅ `codex resume`                               | ✅ `--conversation`                 | ✅ `--resume <id>`              | ✅ `--session <id>`              |
| Turn-end hook (Result validation) (core) | ✅ `Stop`                           | ✅ `Stop`                                       | ✅ `Stop`                           | ✅ `Stop` (`agentStop`)         | ✅ plugin on `session.idle`      |
| Login check (`bun run doctor`) (core)    | ✅ `claude auth status`             | ✅ `codex login status`                         | ✅ `agy models`                     | ✅ `config.json` of the Account | ✅ `opencode models`             |
| Remote Control / Open chat               | ✅ `--remote-control`               | ❌                                              | ❌                                  | ❌                              | ❌                               |
| Now line from the transcript             | ✅ transcript                       | ❌                                              | ❌                                  | ❌                              | ❌                               |
| Usage quota meters                       | ✅ status line                      | ❌                                              | ❌                                  | ❌                              | ❌                               |
| Usage limit detected                     | ✅ `StopFailure`                    | ✅ rollout `task_complete` error                | ✅ `Stop` error                     | ✅ `errorOccurred`              | ✅ plugin on a `retry` status    |
| Usage limit with reset time              | ✅ transcript                       | ❌                                              | ✅ `retryDelay` of the error        | ❌                              | ❌                               |
| Transcript move on Account switch        | ✅ copied                           | ✅ rollout copied                               | ❌                                  | ✅ `session-state/<id>/` copied | ❌                               |
| Minimum CLI version                      | `claude` 2.1.0                      | `codex` 0.170.0                                 | `agy` 1.5.12                        | `copilot` 1.0.114               | `opencode` 1.19.6                |

- **Codex CLI, Remote Control / Open chat:** Codex has no link into a phone or web app; attach to tmux instead.
- **Codex CLI, Now line from the transcript:** the rollout format differs from Claude's transcript; not read yet.
- **Codex CLI, Usage quota meters:** Codex writes `rate_limits` into its rollout; not read yet.
- **Codex CLI, Usage limit with reset time:** only in the message text; the Account pauses for the default interval.
- **Antigravity CLI, Remote Control / Open chat:** `agy --remote-control` exists, but its link isn't read yet; attach to tmux instead.
- **Antigravity CLI, Now line from the transcript:** its transcript format differs from Claude's; not read yet.
- **Antigravity CLI, Usage quota meters:** Antigravity shows the quota only in its `/usage` panel.
- **Antigravity CLI, Transcript move on Account switch:** one Account only: the login is per user (keyring or a file in the home folder), with no folder variable.
- **Copilot CLI, Remote Control / Open chat:** Copilot's `/remote on` could link a session to GitHub; not wired up yet.
- **Copilot CLI, Now line from the transcript:** the session's event log differs from Claude's transcript; not read yet.
- **Copilot CLI, Usage quota meters:** Copilot shows it only in `/usage`; not read yet.
- **Copilot CLI, Usage limit with reset time:** not in the hook's payload; the Account pauses for the default interval.
- **OpenCode, Remote Control / Open chat:** OpenCode's `serve` / `web` could open a session in a browser; not wired up yet.
- **OpenCode, Now line from the transcript:** OpenCode keeps sessions in a SQLite database, not a transcript file; not read yet.
- **OpenCode, Usage quota meters:** OpenCode reports no quota of the provider.
- **OpenCode, Usage limit with reset time:** OpenCode only says when it retries; the Account pauses for the default interval.
- **OpenCode, Transcript move on Account switch:** one Account only: logins and sessions share OpenCode's data folder, which only `XDG_DATA_HOME` moves, and that would move every other tool's data in the session too.
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
   `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` (REQ-006-13).

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
  Coordinator pauses the Account for the default interval (REQ-006-12), since the payload has no reset time.

## Setting up OpenCode

OpenCode (`opencode`) reaches many providers with their own keys or logins, and its Zen gateway has free models that
need no login at all, so it is the cheapest Harness to run for real.

1. Install it, version 1.19.6 or newer: `bun i -g opencode-ai` (or `npm i -g opencode-ai`, or
   `curl -fsSL https://opencode.ai/install | bash`).
2. Nothing else for a free Zen model. For another provider, log in once as the Coordinator's user
   (`opencode providers login`), or give the Coordinator that provider's API key in its environment.
3. Add the Account to `config.ts` with `harness: "opencode"` and no `configDir`:

   ```ts
   accounts: [
     { name: "claude" },
     { name: "zen", harness: "opencode" },
   ],
   ```

   OpenCode keeps its logins and its sessions in one data folder per user (`~/.local/share/opencode`), which only
   `XDG_DATA_HOME` moves. That would move every other tool's data in the session too, and a resume on another Account
   would need the session database copied, so OpenCode has **one Account** (REQ-006-16).

4. Pick an OpenCode model for a Role: `opencode:<provider>/<model>`, e.g. `opencode:opencode/big-pickle` (free) or
   `opencode:anthropic/claude-sonnet-5-5`. The prefix keeps them apart from the same models on their own Harness. The
   Config page lists the free Zen models of OpenCode 1.19.6; free models come and go, and `opencode models` lists the
   current ones. A Role's effort becomes the model's variant (e.g. `high`); a variant the model lacks is ignored.
5. `bun run doctor` checks `opencode`, its version, and that `opencode models` offers a model (REQ-006-05).

How an OpenCode session runs:

- `OPENCODE_CONFIG_DIR=<session>/opencode opencode [--session <id>] --mini --auto --model <provider>/<model> --prompt <prompt>`.
  `--mini` is OpenCode's minimal interactive interface: the full TUI ignores `--prompt` when it opens an existing
  session, so a resume would never get its prompt.
- **Config for the session only:** `OPENCODE_CONFIG_DIR` adds a config folder in the session folder to the user's own
  config: `opencode.json` with `permission: "allow"`, no sharing and no auto-update, and for a Role's effort the
  default agent's variant (`agent.build`, with the same model: OpenCode has no flag for it). Nothing goes into the
  Worktree or `~/.config/opencode`.
- **Hooks:** OpenCode has no shell hooks, only JS plugins. `plugins/coordinator.js` in that folder, written on every
  launch, runs the hook script on OpenCode's events, one at a time in their order, with Claude Code's event names and
  fields: the first prompt of a session in this process as `SessionStart` (session id, model), each user prompt as
  `UserPromptSubmit`, `session.idle` as `Stop`. A blocked `Stop`'s reason goes back as the next prompt
  (`client.session.promptAsync`); the hook recognises it, so it doesn't count as the Owner's message. A turn the Owner
  interrupts (Esc) gets no `Stop`, as with Claude Code, and subagent sessions are left alone. Hook errors go to the
  session's `hook-errors.log`.
- **Resume:** `opencode --session <id>`, never `--continue` (the latest session is ambiguous across Worktrees). An
  unknown id ends the CLI.
- **Usage limit:** OpenCode retries a rate-limited call without end, after the provider's `retry-after`, and reports
  each retry as a `session.status` of type `retry`. The plugin passes them on; the third retry of a rate limit or quota
  is the usage limit (REQ-006-15): the session is marked, the Account pauses for the default interval, and the plugin
  aborts the turn (`client.session.abort`), so it doesn't go on behind the Coordinator's back.

## Testing without a subscription

- **Recorded payloads:** `test/fixtures/codex/` holds hook payloads and a rollout recorded from Codex CLI 0.170.0;
  `test/fixtures/antigravity/` hook payloads recorded from Antigravity CLI 1.5.12, a quota error among them;
  `test/fixtures/copilot/` the hook payloads and a `config.json` recorded from Copilot CLI 1.0.114;
  `test/fixtures/opencode/` the payloads the plugin sent from OpenCode 1.19.6, a rate-limit retry among them.
- **Fake Harness CLI:** `test/support/fake-harness.ts` takes Codex's, Antigravity's, Copilot's or OpenCode's command
  line, fires its hooks and writes a Result, so `bun test` runs a session of each through real tmux and the real hook
  script. For OpenCode it loads the real generated plugin and feeds it OpenCode's events, and `test/opencode.test.ts`
  runs that plugin with a fake OpenCode client (block, abort, interrupt, subagents, a failing hook).
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
- **Real Copilot, fake model:** `bun scripts/smoke-runner.ts --harness copilot --fake-model` runs the real `copilot`
  against the same fake server as its own model provider (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_OFFLINE=true`), with
  no login. This is how the Copilot column was checked: the plugin's hooks and their payloads, the `Stop` block and
  its prompt, resume by id, a session folder copied to another `COPILOT_HOME`, and `errorOccurred` on a 429 from the
  model.
- **Real OpenCode, fake model:** `bun scripts/smoke-runner.ts --harness opencode --fake-model` runs the real
  `opencode` with the fake server as an OpenAI-compatible provider (`OPENCODE_CONFIG_CONTENT`, the server's
  `/v1/chat/completions`) and a data folder of its own, with no login and no cost. This, and the same setup by hand,
  checked the plugin's hooks and payloads, a blocked `Stop` re-prompted, resume by id, and the abort after the third
  429 retry.
- **Real OpenCode, free model:** `bun scripts/smoke-runner.ts --harness opencode` runs `opencode:opencode/big-pickle`,
  a free Zen model (pass `--model opencode:<provider>/<model>` for another). It uses the user's OpenCode data folder.
- **Real Copilot, real model:** `bun scripts/smoke-runner.ts --harness copilot` uses the default `~/.copilot`'s login
  and `copilot:claude-haiku-5.5` (pass `--model copilot:<id>` for another); it skips when there is no login.

## Other Harnesses and models

- **Gemini CLI** is not supported: Antigravity CLI replaced it, and since 2026-06-18 it no longer serves free or Google
  AI Pro/Ultra logins. Antigravity CLI runs the same Gemini models.
- **Models without a Harness of their own** are reached through one that offers them (Copilot CLI for several
  vendors, or Claude Code against an Anthropic-compatible gateway). There is no agent loop of our own.
