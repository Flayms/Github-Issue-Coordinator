# Architecture

One Bun process, the Coordinator, runs a reconcile loop. Every `pollIntervalSec` it lists each configured repository's open issues and PRs, and the head branches of its open PRs (both with an ETag), works out the desired action for each item from its `agent:*` labels and the local store, and hands actions to a scheduler with per-Role Slots. Agents are interactive `claude` sessions in detached tmux windows, registered with Remote Control so the Owner can follow them from the Claude app. Agents have no GitHub write credential: the Coordinator does every GitHub write, including creating the Split-off issues a Planner proposes in its Result (REQ-001-34), and reads for them what they need from GitHub, such as the Linked history of issues and PRs an issue to plan links to (REQ-001-47). Beyond that, every session can read GitHub itself with `gh` and a read-only installation token, which the Coordinator renews before each tick in the session folder's `gh/hosts.yml` (REQ-001-55). Details and rationale: `docs/specs/001-issue-coordinator/plan.md`.

```mermaid
flowchart LR
  GH[(GitHub)] <-- REST, App token --> C[Coordinator]
  C --> S[(bun:sqlite store)]
  C -- tmux + claude --remote-control --> A[Agent sessions<br/>Planner / Implementer / Reviewer]
  A -- hooks --> S
  A -. Remote Control .-> P[Owner's Claude app]
  C -- Tick snapshot --> D[Dashboard<br/>read-only, loopback]
  D -. Tailscale / SSH tunnel .-> P
```

At the end of every tick the Coordinator publishes a Tick snapshot (issues, agent PRs, sessions, the queue with wait reasons, the recent Events). Whenever the Coordinator acts on GitHub (an Assessment, an approval, a block, an agent PR, a Review, a Feedback round, a failure) it records an Event in the store, capped at 200 (REQ-003-15). The dashboard (on by default, [spec 003](specs/003-dashboard/spec.md)) serves only that snapshot: no GitHub calls, no store writes.

## Modules

| Module                         | Responsibility                                                                                                                                                                                                                                                   | Status   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `src/index.ts`                 | Entry point (`bun start`): wires everything, runs the loop, checks for dialogs every 3s                                                                                                                                                                          | T15 done |
| `src/coordinator.ts`           | Reconcile loop: sync finished turns, poll (incl. head, checks and mergeability of agent PRs), derive, schedule across repos, execute                                                                                                                             | T15 done |
| `src/git.ts`                   | Main clone per repo, reset to the default branch; the App token is passed per command, never stored                                                                                                                                                              | T15 done |
| `src/implementer.ts`           | Implementer start (Bundle, Worktree, limited context), push + PR after every turn (with Screenshots, REQ-001-49/50), cleanup after merge/close, re-attach of orphaned agent PRs                                                                                  | T11 done |
| `src/reviewer.ts`              | Reviewer start on a PR-head checkout, one COMMENT review, labels, session closed afterwards                                                                                                                                                                      | T12 done |
| `src/note.ts`                  | The agent note heading every comment, PR and review                                                                                                                                                                                                              | T11 done |
| `src/worktrees.ts`             | Worktree per issue/Bundle (local clone + new or existing remote branch + setup), push, fetch of the default branch for merge-conflict rounds, Screenshot publishing to the orphan branch `agent-screenshots`, review checkouts, removal                          | T10 done |
| `src/doctor.ts`                | `bun run doctor`: read-only setup check (tools, headless browser, login per Account, config, GitHub App, repo access)                                                                                                                                            | T14      |
| `src/config.ts`                | Load and validate `config.ts`; resolve a Role's model and effort per repository                                                                                                                                                                                  | T2 done  |
| `src/labels.ts`                | The `agent:*` labels that carry state on GitHub; setting a PR-phase label on the issues and their agent PR (REQ-001-54)                                                                                                                                          | T3 done  |
| `src/github/app-auth.ts`       | GitHub App JWT; installation token per repository owner, cached until near expiry; a separate read-only token for agents (REQ-001-55)                                                                                                                            | T3 done  |
| `src/github/read-tokens.ts`    | REQ-001-55: the current read-only token per repository, renewed before each tick; the runner writes it to each session's `gh/hosts.yml`                                                                                                                          | done     |
| `src/github/client.ts`         | REST client: ETag polling (open items; open PRs with head branch), comments, timeline label actor, labels, PRs (incl. state, mergeability, draft status via GraphQL), Reviews, checks                                                                            | T3 done  |
| `src/store.ts`                 | `bun:sqlite`: sessions (Role, issues, Claude session id, state, Account), the usage-limit pause per Account, per-issue bookkeeping, Split-off issues and the newest 200 Events                                                                                   | T4 done  |
| `src/events.ts`                | Records an Event after a GitHub action; a store error is only logged (REQ-003-15)                                                                                                                                                                                | done     |
| `src/state.ts`                 | Pure: issue state from labels; actions from labels, store and live tmux windows                                                                                                                                                                                  | T4 done  |
| `src/scheduler.ts`             | Pure: which queued work starts, which idle sessions close (Slots, priority, pause while every Account is paused, live limit)                                                                                                                                     | T5 done  |
| `src/runner.ts`, `src/tmux.ts` | Start/resume/close `claude --remote-control` sessions in tmux windows `s<id>` (prompt via a file) on the first free Account (`CLAUDE_CONFIG_DIR`, transcript copied when a resume changes Account); answer the trust dialog                                      | T6 done  |
| `src/accounts.ts`              | Accounts (spec 004): first free Account, end of the all-Accounts pause, Account folder, transcript copy                                                                                                                                                          |
| `src/hook.ts`                  | Claude Code hook: session id, Owner vs. Coordinator prompts, Result validation on `Stop`, payload log                                                                                                                                                            | T6 done  |
| `src/prompts.ts`, `prompts/`   | Role prompts with repo overrides (contract: spec 002); permissions per Role (`dontAsk` read-only, or `auto` in the sandbox)                                                                                                                                      | T7 done  |
| `src/planner.ts`               | Planner pass (with the Linked history of linked items), plan revision (from scratch on a body edit), Assessment comments, Replies, labels, sync after every turn                                                                                                 | T8 done  |
| `src/results.ts`               | Result schemas per Role and the instructions shown to sessions                                                                                                                                                                                                   | T6 done  |
| `src/browser.ts`               | The host's headless browser: lookup, the `--no-sandbox` screenshot arguments, and the doctor's start check; shared with the smoke runner's Screenshot scenario (REQ-001-53)                                                                                      | done     |
| `src/screenshots.ts`           | Checks the Screenshots an Implementer lists (path, symlink, type, size, count) and renders the PR body's Screenshots section (REQ-001-50/51)                                                                                                                     | done     |
| `src/dashboard/`               | Read-only dashboard (spec 003): `server.ts` (`Bun.serve`, token, GET only, `/`, `/config`, `/assets/*`), `view.ts` (pure view model), `html.ts` / `config-html.ts` (escaped HTML), `assets.ts` + `assets/` (CSS, optional script, self-hosted fonts; fixed list) | done     |

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
