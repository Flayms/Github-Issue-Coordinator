### Copilot CLI (#176)

Copilot CLI runs hooks under Claude Code's event names with Claude Code's payload fields, so `src/hook.ts` serves it too. The hooks go into a plugin in the session folder (`--plugin-dir`): no flag takes a hooks file, and the Worktree's `.github/hooks/` or the Account's `COPILOT_HOME` would leak into commits or other sessions. Two gaps: a blocked `Stop`'s reason comes back as a prompt (recognised by its Result instructions), and a usage limit fires `errorOccurred` instead of `Stop`. The login check reads the Account's `config.json`, since Copilot has no status command, so the `Harness` interface's `loginCheck` can now be either a command or a folder check. Copilot's models are named `copilot:<id>` in the Model catalogue and the adapter strips the prefix.

- [x] Spec: REQ-006-10 … REQ-006-13
- [x] `src/harness/copilot.ts`: launch, plugin hooks, resume by id, session folder copy, login from `config.json` (REQ-006-10, REQ-006-11, REQ-006-13)
- [x] Hook: the block reason is the Coordinator's; `errorOccurred` on a usage limit (REQ-006-10, REQ-006-12)
- [x] Model catalogue entries with the `copilot:` prefix (REQ-006-10)
- [x] Recorded payloads, the fake Harness CLI with Copilot's command line, contract suite, smoke runner `--harness copilot [--fake-model]`
- [x] Docs: harnesses (matrix, setup), README, setup, how-it-works, architecture, glossary, known pitfalls
- [ ] Manual: one real Copilot turn with a real login

### OpenCode (#182)

OpenCode has no shell hooks, only JS plugins. The adapter writes a config folder into the session folder (`OPENCODE_CONFIG_DIR`, read besides the user's config) with `opencode.json` (permissions, the effort as the default agent's variant) and a generated plugin that runs the hook script on OpenCode's events under Claude Code's names, and acts on its answer: a block reason becomes the next prompt, an `abort` ends a rate-limited turn. Sessions run in `opencode --mini`, since the full TUI ignores `--prompt` on a resume. `hookOutput` now also gets an empty answer, so OpenCode's adapter can answer the usage limit with `abort`; `writeSessionConfig` gets the Role's model and `env` the session folder.

- [x] Spec: REQ-006-14 … REQ-006-16, REQ-006-05 extended
- [x] `src/harness/opencode.ts`: launch, config folder, plugin, resume by id, login check (REQ-006-14, REQ-006-05)
- [x] Usage limit: the third rate-limit retry, abort (REQ-006-15)
- [x] Model catalogue entries with the `opencode:` prefix (REQ-006-14)
- [x] Recorded payloads, the fake Harness CLI with OpenCode's command line (running the real plugin), plugin tests, contract suite, smoke runner `--harness opencode [--fake-model]`
- [x] Docs: harnesses (matrix, setup), README, setup, how-it-works, architecture, glossary, known pitfalls
- [x] Manual: real turns with the free Zen model `opencode/big-pickle`
- [ ] Manual: a real provider's quota error
