# T0 spike: unattended Remote Control sessions

Checks the assumptions behind spec 001 (see `docs/specs/001-issue-coordinator/plan.md`, task T0) on the real server. Throwaway code: once the results are recorded in `docs/known-pitfalls.md` and the spec, this folder can be deleted.

## What it does

1. Preflight: `claude`, `tmux` and `git` versions, the required CLI flags, `claude auth status`.
2. **Phase A:** starts `claude --remote-control "t0 coordinator test" "<prompt>"` in a detached tmux session, inside a throwaway git repo.
   - The prompt deliberately does not ask for the Result file, so the `Stop` hook has to block the stop and tell the session to write it.
   - It asks you whether the session shows up in the Claude app.
   - Optionally, you send it a message from your phone, and the script checks that the hooks see it.
3. Kills the tmux session, which is how the Coordinator closes idle sessions.
4. **Phase B:** resumes the session with `--resume <id>` and a new prompt, checks that it remembers its first turn, and asks again whether it's visible on your phone.
5. Reads the session transcript to see which model actually ran.
6. Writes a report to `spikes/t0/reports/`.

It never touches your real repos. Everything lives in a temp dir that the report names.

## Run

On the server, as the user the Coordinator will run as. That user must have logged in to Claude once with `/login` (a subscription login, not `setup-token`).

```bash
bun spikes/t0/t0.ts --model sonnet            # interactive: asks you to check your phone
bun spikes/t0/t0.ts --no-phone                # skip the phone questions
```

| Option | Meaning |
| ------ | ------- |
| `--model <m>` / `--effort <e>` | Passed to `claude`; checked against the transcript / `--help` |
| `--timeout <sec>` | Per-step wait, default 300 |
| `--pretrust` | Marks the temp repo as trusted in `~/.claude.json` (backup is written first). Use it if the first run hangs on a trust dialog |
| `--keep` | Leave the tmux session running (`tmux attach -t coordinator-t0`) for debugging |

Exit code 1 if any check failed. Paste the report back into the planning conversation.
