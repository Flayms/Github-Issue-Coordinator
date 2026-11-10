# 001 – Issue coordinator: Plan

## Approach

A single Bun process (`systemd` service, dedicated `agent` Linux user) runs a **reconcile loop**. Every `pollIntervalSec`, for each repository, it fetches open issues and PRs, sending an ETag. It then derives the desired action for each item from its labels plus the local store, and hands actions to a scheduler with per-Role Slots.

### GitHub

- **Identity:** a private GitHub App with Issues RW, Pull requests RW, Contents RW, Checks R and Metadata R, installed on the selected repos. Installation tokens are minted in-process.
- **Authorship checks:** approvals and commands are checked against the Owner's numeric user id. Label actors are checked via the issue timeline.

### Session runner (interactive + Remote Control)

- **Start:** `tmux new-window -d -c <dir> -n <name> "claude --remote-control '<repo>#<n> <role>' --model <m> --settings <hooks.json> --permission-mode <…> '<prompt>'"`.
- **Resume:** the same command with `--resume <session_id>` and the new prompt.
- **Hooks:** they call a small Bun hook script that writes events to the store.
  - `SessionStart` records the session id.
  - `UserPromptSubmit` marks the session busy and tags the turn as Owner-initiated.
  - `Stop` validates the Result file against the Role's schema. It blocks the stop with the reason when the file is invalid (REQ-001-21). Otherwise it marks the session idle and queues a sync.
- **Result files** live outside the repo, at `state/<repo>/<issue>/<role>.result.json`, so they never end up in a commit.
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
- [ ] T2 Config loading and validation. (REQ-001-01, REQ-001-08, REQ-001-22)
- [ ] T3 GitHub App auth and client with ETag polling, timeline actor lookup, label helpers and PR review posting. (REQ-001-01, REQ-001-04, REQ-001-10, REQ-001-15)
- [ ] T4 Store and the state derivation from labels and store as a pure function, with tests. (REQ-001-07, REQ-001-16)
- [ ] T5 Scheduler: Slots per Role plus a total limit, priority order, usage-limit pause, idle-session eviction. (REQ-001-08, REQ-001-17, REQ-001-20, REQ-001-23)
- [ ] T6 Session runner: tmux + Remote Control start/resume/close, hook script, Result validation, Owner-busy guard. (REQ-001-18, REQ-001-19, REQ-001-21)
- [ ] T7 Prompts and per-Role model resolution, with per-repo overrides. (REQ-001-22)
- [ ] T8 Planner pass and Assessment rendering/editing, plus the sync after any turn. (REQ-001-02, REQ-001-03, REQ-001-19)
- [ ] T9 Approval handling and blocked/unblock logic. (REQ-001-04, REQ-001-05)
- [ ] T10 Worktree manager: bare clone, create, setup command, review checkouts, cleanup, `maxWorktrees`. (REQ-001-06, REQ-001-14)
- [ ] T11 Implementer run, push and PR creation, plus the sync after any turn. (REQ-001-06, REQ-001-09, REQ-001-19)
- [ ] T12 Reviewer run and PR review posting. (REQ-001-10)
- [ ] T13 Feedback rounds: blocking findings, Owner `/agent` and changes-requested, failing checks. (REQ-001-11, REQ-001-12, REQ-001-13, REQ-001-24)
- [ ] T14 Deployment: systemd unit, `agent` user, a setup guide for the GitHub App, the ruleset, the one-time `/login`, and disabling the GitHub Actions reviewer. (REQ-001-15)
