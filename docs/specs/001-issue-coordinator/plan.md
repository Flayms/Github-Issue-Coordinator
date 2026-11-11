# 001 – Issue coordinator: Plan

## Approach

A single Bun process (`systemd` service, dedicated `agent` Linux user) runs a **reconcile loop**. Every `pollIntervalSec`, for each repository, it fetches open issues and PRs, sending an ETag. It then derives the desired action for each item from its labels plus the local store, and hands actions to a scheduler with per-Role Slots.

### GitHub

- **Identity:** a private GitHub App with Issues RW, Pull requests RW, Contents RW, Checks R and Metadata R, installed on the selected repos. Installation tokens are minted in-process.
- **Authorship checks:** approvals and commands are checked against the Owner's numeric user id. Label actors are checked via the issue timeline.

### Session runner (interactive + Remote Control)

- **Start:** `tmux new-window -d -c <dir> -n <name> "claude --remote-control '<repo>#<n> <role>' --model <m> --settings <hooks.json> --permission-mode <…> '<prompt>'"`.
- **Resume:** kill the idle session's window and run the same command with `--resume <session_id>` and the new prompt (keeps the conversation and the phone chat; verified in the T6 smoke test).
- **Hooks:** they call a small Bun hook script that writes events to the store.
  - `SessionStart` records the session id.
  - `UserPromptSubmit` marks the session busy and tags the turn as Owner-initiated.
  - `Stop` validates the Result file against the Role's schema. It blocks the stop with the reason when the file is invalid (REQ-001-21). Otherwise it marks the session idle and queues a sync.
- **Result files** live outside the repo, at `state/sessions/<id>/result.json` (next to the session's settings and hook log), so they never end up in a commit. The runner deletes the file before every Coordinator prompt, so an old Result cannot pass for a new turn.
- **Closing a session** means killing its tmux window, which happens only while the session is idle. `maxLiveSessions` (2 on the 4 GB server) counts every live `claude` process, running or idle. A usage-limit message is detected from the transcript or the hook payload (format to be pinned down in T0).

### Roles

| Role        | Where it runs                                               | Writes          | Result schema                                                          |
| ----------- | ----------------------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| Planner     | Main clone, read-only tools                                 | —               | `[{issue, verdict, approach, bundleWith[], blockedBy[], questions[]}]` |
| Implementer | Own Worktree (one bare clone per repo)                      | Commits locally | `{prTitle, prBody, summary}`                                           |
| Reviewer    | Temporary detached checkout of the PR head, read-only tools | —               | `{summary, findings[{path, line, severity, blocking, body}]}`          |

### Prompts and models

- **Default prompts** live in `prompts/<role>.md` in this repo. A target repo can override one with `.github/coordinator/<role>.md`; only the Owner can push to target repos.
- **Models:** each Role has its own model and optional effort in the config, with per-repo overrides.

### Store

`bun:sqlite` holds session ids and their state (running/idle/closed, last activity, Owner-busy), Worktree paths, the reviewed head SHAs, feedback-round counts, the last handled comment/review ids, and the usage-limit pause.

### Config sketch (`config.ts`, typed)

```ts
export default {
  owner: { login: "…", id: 0 },
  pollIntervalSec: 60,
  limits: {
    maxRunning: 1,
    maxPlanners: 1,
    maxImplementers: 1,
    maxReviewers: 1,
    maxLiveSessions: 2,
    idleTimeoutMin: 30,
    maxWorktrees: 5,
    maxFeedbackRounds: 2,
  },
  roles: {
    planner: { model: "…", effort: "…" },
    implementer: { model: "…" },
    reviewer: { model: "…" },
  },
  repos: [{ name: "owner/repo", setup: "bun install", roles: { reviewer: { model: "…" } } }],
};
```

## Tasks

- [x] T0 Spike on the server (`spikes/t0/`, 2026-11-10, Claude Code 2.1.322). Results are in the spec's Assumptions and `known-pitfalls.md`. (REQ-001-17–22)
  - (a) pass: a detached tmux session shows up on the phone, once the folder trust dialog is answered.
  - (b) pass: resuming keeps the session id, the memory of earlier turns and the same phone conversation.
  - (c) pass: hooks fire, including for messages sent from the phone, and a `Stop` hook can block with a reason.
  - (d) pass: `--model sonnet` ran `claude-sonnet-5-5`, and `--effort` exists. A value for `--effort` wasn't tested.
  - (e) open: the usage-limit signal can't be triggered on demand. The runner must log unknown `Stop`/`Notification` payloads so the shape can be captured when it happens.
- [x] T1 Project tooling: `package.json`, Biome (code and Markdown; `spikes/` excluded), `tsc --noEmit` (TypeScript 7), `bun test`; AGENTS.md commands updated.
- [x] T2 Config loading and validation (`src/config.ts`, zod; `config.example.ts`; `roleSettings` resolves model/effort with repo overrides, prompts follow in T7). (REQ-001-01, REQ-001-08, REQ-001-22)
- [x] T3 GitHub App auth and client with ETag polling, timeline actor lookup, label helpers and PR review posting (`src/github/`; installation looked up per repo owner, so the config only holds the App id and key path; `git push` with the token follows in T10/T11). (REQ-001-01, REQ-001-04, REQ-001-10, REQ-001-15)
- [x] T4 Store (`src/store.ts`: sessions, per-issue bookkeeping) and the state derivation as a pure function (`src/state.ts`: issue state from labels, Planner trigger, no double pickup, restart recovery; later tasks add their triggers there). (REQ-001-07, REQ-001-16)
- [x] T5 Scheduler (`src/scheduler.ts`, pure): Slots per Role plus a total limit, priority order, usage-limit pause (persisted in the store), idle timeout and live-session limit with the eviction order. (REQ-001-08, REQ-001-17, REQ-001-20)
- [x] T6 Session runner (`src/runner.ts`, `src/tmux.ts`), hook script (`src/hook.ts`), Result schemas (`src/results.ts`), Owner-busy guard; smoke-tested against real tmux + claude with `bun scripts/smoke-runner.ts`. (REQ-001-18, REQ-001-19, REQ-001-21)
- [x] T7 Prompts (`prompts/<role>.md`, repo override `.github/coordinator/<role>.md`, `src/prompts.ts`) and per-Role permissions: Planner/Reviewer `dontAsk` with read-only tools plus their Result file; Implementer `bypassPermissions` in the sandbox, whose warning the Owner accepts once per Linux user. (REQ-001-22, REQ-001-25)
- [ ] T8 Planner pass and Assessment rendering/editing, plus the sync after any turn. (REQ-001-02, REQ-001-03, REQ-001-19)
- [ ] T9 Approval handling and blocked/unblock logic. (REQ-001-04, REQ-001-05)
- [ ] T10 Worktree manager: bare clone, create, setup command, review checkouts, cleanup, `maxWorktrees`. (REQ-001-06, REQ-001-14)
- [ ] T11 Implementer run, push and PR creation, plus the sync after any turn. (REQ-001-06, REQ-001-09, REQ-001-19)
- [ ] T12 Reviewer run and PR review posting; close the session once posted. (REQ-001-10, REQ-001-23)
- [ ] T13 Feedback rounds: blocking findings, Owner `/agent` and changes-requested, failing checks. (REQ-001-11, REQ-001-12, REQ-001-13, REQ-001-24)
- [ ] T14 Deployment: systemd unit, `agent` user, a setup guide for the GitHub App, the ruleset, the one-time `/login`, and disabling the GitHub Actions reviewer. (REQ-001-15)
