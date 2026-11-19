# 006 – Harnesses: Plan

## Approach

A `Harness` interface in `src/harness/` with one adapter per agent CLI (`claude.ts`, `codex.ts`). Each adapter has the core methods (command line, per-session config, dialogs, login check) and declares its Harness features as data; optional features come with optional methods (`moveTranscript`, `endedTurn`). The runner, the setup check and the dashboard ask the adapter instead of hard-coding `claude`. The Harness follows from the model (`harnessOfModel`), so the Owner picks one thing per Role and invalid pairs like Codex + Opus can't happen. A session records its Harness, so a resume stays on it.

Codex needs nothing written into the Account's `CODEX_HOME`: its hooks go on the command line as `-c` overrides. Its hook events and payload fields match Claude Code's, so `src/hook.ts` serves both. The one gap, no Stop hook on the usage limit, is covered by reading the rollout's last turn event every few seconds.

The feature matrix in `docs/harnesses.md` is generated from the declarations (`src/harness/matrix.ts`) and compared by a test, so it can't drift.

Testing without subscriptions: recorded Codex payloads, a fake Harness CLI that drives the real runner, tmux and hook script in `bun test`, a contract suite over every adapter, and a smoke run of the real `codex` binary against a fake model server.

## Tasks

- [x] Spec 006, glossary terms Harness and Harness feature
- [x] `Harness` interface and Claude adapter, no behaviour change; store migration `claude_session_id` → `agent_session_id`, `harness` column (REQ-006-03)
- [x] Codex adapter: launch, resume, hooks, Result on Stop, dialogs, usage limit from the rollout, rollout copy (REQ-006-01, REQ-006-04)
- [x] Accounts and the Model catalogue know their Harness; config check; scheduler pauses per Harness (REQ-006-01, REQ-006-02)
- [x] Config page's Model dropdown grouped by Harness (REQ-006-01)
- [x] Dashboard uses Harness features where declared (REQ-006-04)
- [x] Setup check per Harness (REQ-006-05)
- [x] `docs/harnesses.md` with the generated matrix and its test (REQ-006-06)
- [x] Fake Harness CLI, contract suite, smoke runner `--harness` and `--fake-model`
- [x] Docs: README, architecture, how-it-works, setup, glossary, known pitfalls
- [ ] Manual: one real Codex Planner turn on a scratch repo with a real login

### Copilot CLI (#176)

Copilot CLI runs hooks under Claude Code's event names with Claude Code's payload fields, so `src/hook.ts` serves it too. The hooks go into a plugin in the session folder (`--plugin-dir`): no flag takes a hooks file, and the Worktree's `.github/hooks/` or the Account's `COPILOT_HOME` would leak into commits or other sessions. Two gaps: a blocked `Stop`'s reason comes back as a prompt (recognised by its Result instructions), and a usage limit fires `errorOccurred` instead of `Stop`. The login check reads the Account's `config.json`, since Copilot has no status command, so the `Harness` interface's `loginCheck` can now be either a command or a folder check. Copilot's models are named `copilot:<id>` in the Model catalogue and the adapter strips the prefix.

- [x] Spec: REQ-006-07 … REQ-006-10
- [x] `src/harness/copilot.ts`: launch, plugin hooks, resume by id, session folder copy, login from `config.json` (REQ-006-07, REQ-006-08, REQ-006-10)
- [x] Hook: the block reason is the Coordinator's; `errorOccurred` on a usage limit (REQ-006-07, REQ-006-09)
- [x] Model catalogue entries with the `copilot:` prefix (REQ-006-07)
- [x] Recorded payloads, the fake Harness CLI with Copilot's command line, contract suite, smoke runner `--harness copilot [--fake-model]`
- [x] Docs: harnesses (matrix, setup), README, setup, how-it-works, architecture, glossary, known pitfalls
- [ ] Manual: one real Copilot turn with a real login
