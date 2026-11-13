# Architecture

One Bun process, the Coordinator, runs a reconcile loop. Every `pollIntervalSec` it lists each configured repository's open issues and PRs (with an ETag), works out the desired action for each item from its `agent:*` labels and the local store, and hands actions to a scheduler with per-Role Slots. Agents are interactive `claude` sessions in detached tmux windows, registered with Remote Control so the Owner can follow them from the Claude app. Agents have no GitHub credentials: the Coordinator does every GitHub write. Details and rationale: `docs/specs/001-issue-coordinator/plan.md`.

```mermaid
flowchart LR
  GH[(GitHub)] <-- REST, App token --> C[Coordinator]
  C --> S[(bun:sqlite store)]
  C -- tmux + claude --remote-control --> A[Agent sessions<br/>Planner / Implementer / Reviewer]
  A -- hooks --> S
  A -. Remote Control .-> P[Owner's Claude app]
```

## Modules

| Module                         | Responsibility                                                                                                                                   | Status   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `src/index.ts`                 | Entry point (`bun start`): wires everything, runs the loop, checks for dialogs every 3s                                                          | T15 done |
| `src/coordinator.ts`           | Reconcile loop: sync finished turns, poll (incl. head, checks and mergeability of agent PRs), derive, schedule across repos, execute             | T15 done |
| `src/git.ts`                   | Main clone per repo, reset to the default branch; the App token is passed per command, never stored                                              | T15 done |
| `src/implementer.ts`           | Implementer start (Bundle, Worktree, limited context), push + PR after every turn, cleanup after merge/close                                     | T11 done |
| `src/reviewer.ts`              | Reviewer start on a PR-head checkout, one COMMENT review, labels, session closed afterwards                                                      | T12 done |
| `src/note.ts`                  | The agent note heading every comment, PR and review                                                                                              | T11 done |
| `src/worktrees.ts`             | Worktree per issue/Bundle (local clone + branch + setup), push, fetch of the default branch for merge-conflict rounds, review checkouts, removal | T10 done |
| `src/doctor.ts`                | `bun run doctor`: read-only setup check (tools, login, config, GitHub App, repo access)                                                          | T14      |
| `src/config.ts`                | Load and validate `config.ts`; resolve a Role's model and effort per repository                                                                  | T2 done  |
| `src/labels.ts`                | The `agent:*` labels that carry state on GitHub                                                                                                  | T3 done  |
| `src/github/app-auth.ts`       | GitHub App JWT; installation token per repository owner, cached until near expiry                                                                | T3 done  |
| `src/github/client.ts`         | REST client: ETag polling, comments, timeline label actor, labels, PRs (incl. mergeability), Reviews, checks                                     | T3 done  |
| `src/store.ts`                 | `bun:sqlite`: sessions (Role, issues, Claude session id, state) and per-issue bookkeeping                                                        | T4 done  |
| `src/state.ts`                 | Pure: issue state from labels; actions from labels, store and live tmux windows                                                                  | T4 done  |
| `src/scheduler.ts`             | Pure: which queued work starts, which idle sessions close (Slots, priority, pause, live limit)                                                   | T5 done  |
| `src/runner.ts`, `src/tmux.ts` | Start/resume/close `claude --remote-control` sessions in tmux windows `s<id>`; answer the trust dialog                                           | T6 done  |
| `src/hook.ts`                  | Claude Code hook: session id, Owner vs. Coordinator prompts, Result validation on `Stop`, payload log                                            | T6 done  |
| `src/prompts.ts`, `prompts/`   | Role prompts with repo overrides (design: `docs/prompts.md`); permissions per Role (`dontAsk` read-only, or `auto` in the sandbox)               | T7 done  |
| `src/planner.ts`               | Planner pass, plan revision, Assessment comments and labels, sync after every Planner turn                                                       | T8 done  |
| `src/results.ts`               | Result schemas per Role and the instructions shown to sessions                                                                                   | T6 done  |

## Tech Stack

| Concern | Technology                            | Purpose                                                    |
| ------- | ------------------------------------- | ---------------------------------------------------------- |
| Runtime | Bun, TypeScript                       | Daemon, hook scripts, tests (`bun test`)                   |
| Lint    | Biome, `tsc --noEmit` (TypeScript 7)  | Formatting and linting (code and Markdown), types          |
| Config  | zod                                   | Validate `config.ts` (later also Result files)             |
| GitHub  | REST API via a private GitHub App     | The Coordinator's own identity                             |
| Agents  | Claude Code CLI, tmux, Remote Control | Interactive sessions the Owner can follow                  |
| State   | `bun:sqlite`                          | Session ids, Worktrees, rounds (T4)                        |
| Service | systemd on Ubuntu                     | `deploy/github-issue-coordinator.service`, `docs/setup.md` |
