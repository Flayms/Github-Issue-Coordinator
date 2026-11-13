# github-issue-coordinator

A self-hosted Bun daemon that polls GitHub and runs Claude Code agents. They triage, plan, implement and review your issues (one Worktree per issue), with your approval as the gate. Every agent session also shows up in the Claude app, where you can follow it live and chat with it.

## How it works

1. **You open an issue.** Only issues you authored are considered; comments, labels and reviews by anyone else are ignored.
2. **The Planner assesses it** and posts an Assessment comment: proposed approach, questions, and Coordination notes ("do together with #N", "blocked by #N"). Label: `agent:proposed`, `agent:needs-refinement` or `agent:wontfix-proposed`. Reply with feedback to revise the plan; the comment is edited in place.
3. **You approve** with `/approve [notes]` or the `agent:approved` label. Nothing said inside a session counts as approval.
4. **The Implementer works on it** in its own Worktree and branch (`agent/<issue>-<slug>`); bundled issues share one. The Coordinator pushes and opens a PR that closes the issues.
5. **The Reviewer reviews the PR** once its checks pass and it has no merge conflicts, as one review with inline comments (never an approval). Blocking findings, failing checks and merge conflicts go back to the Implementer, up to `maxFeedbackRounds` times, then the PR is labelled `agent:failed`.
6. **You merge.** The Worktree and sessions are cleaned up.

Agents never get GitHub credentials; the Coordinator does every GitHub write as its own GitHub App.

Each Role's prompt is in `prompts/`; a repository can replace one with `.github/coordinator/<role>.md`. [docs/prompts.md](docs/prompts.md) explains what each Role decides, which tools it has, and why.

## Commands (comments by you)

| Command            | Where             | Effect                                                            |
| ------------------ | ----------------- | ----------------------------------------------------------------- |
| `/approve [notes]` | proposed issue    | Approves the plan; notes go to the Implementer                    |
| `/agent <text>`    | agent PR          | A Feedback round with your text (also: "Request changes" reviews) |
| `/wake`            | agent issue or PR | Resumes its closed session so you can chat in the Claude app      |
| any other comment  | proposed issue    | Revises the plan                                                  |

## Labels

`agent:planning`, `agent:proposed`, `agent:needs-refinement`, `agent:wontfix-proposed`, `agent:approved`, `agent:blocked`, `agent:in-progress`, `agent:pr-open`, `agent:reviewing`, `agent:reviewed`, `agent:failed`. The Coordinator creates them in each repository.

## Setup

See [docs/setup.md](docs/setup.md): a Linux user with Claude Code logged in, a GitHub App, a ruleset per repository, `config.ts`, and the systemd service. In short:

```sh
bun install
cp config.example.ts config.ts   # fill in the Owner, GitHub App, Roles and repositories
bun run doctor                   # checks the setup
bun start                        # or run it as the systemd service
```

## Development

`bun test` · `bun run lint` · `bun scripts/smoke-runner.ts` (real tmux + claude). See `AGENTS.md` and `docs/`.
