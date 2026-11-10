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

| Module                   | Responsibility                                                                          | Status  |
| ------------------------ | --------------------------------------------------------------------------------------- | ------- |
| `src/config.ts`          | Load and validate `config.ts`; resolve a Role's model and effort per repository         | T2 done |
| `src/labels.ts`          | The `agent:*` labels that carry state on GitHub                                         | T3 done |
| `src/github/app-auth.ts` | GitHub App JWT; installation token per repository owner, cached until near expiry       | T3 done |
| `src/github/client.ts`   | REST client: ETag polling, comments, timeline label actor, labels, PRs, Reviews, checks | T3 done |
| store, state derivation  | `bun:sqlite`; desired action per item as a pure function                                | T4      |
| scheduler                | Slots per Role, total and live-session limits, priority order, usage-limit pause        | T5      |
| session runner           | tmux + Remote Control start/resume/close, hook script, Result validation                | T6      |

## Tech Stack

| Concern | Technology                            | Purpose                                           |
| ------- | ------------------------------------- | ------------------------------------------------- |
| Runtime | Bun, TypeScript                       | Daemon, hook scripts, tests (`bun test`)          |
| Lint    | Biome, `tsc --noEmit` (TypeScript 7)  | Formatting and linting (code and Markdown), types |
| Config  | zod                                   | Validate `config.ts` (later also Result files)    |
| GitHub  | REST API via a private GitHub App     | The Coordinator's own identity                    |
| Agents  | Claude Code CLI, tmux, Remote Control | Interactive sessions the Owner can follow         |
| State   | `bun:sqlite`                          | Session ids, Worktrees, rounds (T4)               |
| Service | systemd on Ubuntu                     | Deployment (T14)                                  |
