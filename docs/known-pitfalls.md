# Known pitfalls

Problems hit during development — either to avoid them in the future or to fix later on.

| Pitfall | Symptom | Workaround / fix | Status |
| ------- | ------- | ---------------- | ------ |
| Folder trust dialog on every new directory | An interactive `claude` started in a new folder (e.g. a fresh Worktree) stops at "Is this a project you created or one you trust?" with "No, exit" preselected. Seen in the T0 spike, Claude Code 2.1.322 | Pre-trust the path in `~/.claude.json` (`projects[<path>].hasTrustDialogAccepted`, spike `--pretrust`), or answer the dialog via `tmux send-keys Down Enter`. Which one works is being confirmed by the T0 rerun | open |
| `UserPromptSubmit` hook doesn't fire for Remote Control messages | A message sent from the phone reached the session and was answered, but no `UserPromptSubmit` event arrived. Seen in the T0 spike, Claude Code 2.1.322 | Detect Owner activity by watching the session transcript (`transcript_path`); whether `Stop` fires for remote turns is being confirmed by the T0 rerun | open |
| Subscription login expiry | `claude auth status` reports a `loginExpiresAt` about 2 weeks out | Unknown whether it auto-refreshes; the Coordinator should check `claude auth status` and warn before expiry | open |
