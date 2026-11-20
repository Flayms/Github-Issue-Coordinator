### Copilot CLI (#176)

Copilot CLI runs hooks under Claude Code's event names with Claude Code's payload fields, so `src/hook.ts` serves it too. The hooks go into a plugin in the session folder (`--plugin-dir`): no flag takes a hooks file, and the Worktree's `.github/hooks/` or the Account's `COPILOT_HOME` would leak into commits or other sessions. Two gaps: a blocked `Stop`'s reason comes back as a prompt (recognised by its Result instructions), and a usage limit fires `errorOccurred` instead of `Stop`. The login check reads the Account's `config.json`, since Copilot has no status command, so the `Harness` interface's `loginCheck` can now be either a command or a folder check. Copilot's models are named `copilot:<id>` in the Model catalogue and the adapter strips the prefix.

- [x] Spec: REQ-006-10 … REQ-006-13
- [x] `src/harness/copilot.ts`: launch, plugin hooks, resume by id, session folder copy, login from `config.json` (REQ-006-10, REQ-006-11, REQ-006-13)
- [x] Hook: the block reason is the Coordinator's; `errorOccurred` on a usage limit (REQ-006-10, REQ-006-12)
- [x] Model catalogue entries with the `copilot:` prefix (REQ-006-10)
- [x] Recorded payloads, the fake Harness CLI with Copilot's command line, contract suite, smoke runner `--harness copilot [--fake-model]`
- [x] Docs: harnesses (matrix, setup), README, setup, how-it-works, architecture, glossary, known pitfalls
- [ ] Manual: one real Copilot turn with a real login
