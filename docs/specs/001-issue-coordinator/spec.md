# 001 – Issue coordinator

**Status:** Draft

## Goal

The Owner (the single human user) wants GitHub issues across their public and private repositories triaged, planned, implemented and reviewed by Claude Code agents running on their own server. Agents must be stateful per issue and stay within an explicit approval gate. The Owner steers everything through GitHub (labels, comments). Every agent session also shows up automatically in the Claude app on their phone, so they can follow it live and chat with it, without ever running a command on the server.

## Requirements

### REQ-001-01 Repository and author scope

- **Given** a list of configured repositories
- **When** the Coordinator polls
- **Then** it considers only issues authored by the Owner
- **And** it ignores comments, labels and reviews by anyone except the Owner and the Coordinator's own bot identity

### REQ-001-02 Planner pass

- **Given** one or more in-scope open issues without any `agent:*` label
- **When** a planner Slot is free
- **Then** the Coordinator sets `agent:planning` on them and runs one Planner session over all of them, with all in-scope open issues and open PRs as context
- **And** posts one Assessment comment per issue with a verdict (`proposed` / `needs-refinement` / `wontfix-proposed`), a proposed approach, and Coordination notes
- **And** replaces `agent:planning` with the matching `agent:proposed` / `agent:needs-refinement` / `agent:wontfix-proposed` label
- **And** closes the batch session once all its Assessments are posted

### REQ-001-03 Plan revision on Owner feedback

- **Given** an issue labelled `agent:proposed`, `agent:needs-refinement` or `agent:wontfix-proposed`
- **When** the Owner posts a comment that is not a command, or edits the issue body
- **Then** that issue's own Planner session is resumed with the feedback, or started fresh with the issue and its current Assessment as context if it has none yet
- **And** the Assessment comment is edited in place (not duplicated) and the label updated

### REQ-001-04 Approval only by the Owner on GitHub

- **Given** an issue labelled `agent:proposed`
- **When** the Owner adds `agent:approved` or comments `/approve [notes]`
- **Then** the issue becomes approved, and any notes are passed to the Implementer
- **And** when anyone else adds `agent:approved`, the Coordinator removes the label and does not start an Implementer
- **And** nothing said inside an agent session counts as approval

### REQ-001-05 Blocked issues are held back

- **Given** an approved issue whose Assessment lists "blocked by #N" and #N is open
- **When** the Coordinator schedules work
- **Then** the issue gets `agent:blocked` instead of starting
- **And** when #N is closed, the issue returns to `agent:approved`

### REQ-001-06 Bundles

- **Given** an approved issue whose Assessment bundles it with other issues
- **When** the Implementer starts
- **Then** all issues in the Bundle share one Worktree, one branch and one PR that closes each of them

### REQ-001-07 No double pickup

- **Given** an issue labelled `agent:planning`, `agent:in-progress` or `agent:reviewing`
- **When** the Coordinator polls again, including after a restart
- **Then** it does not start a second session of the same Role for that issue

### REQ-001-08 Concurrency limits

- **Given** limits `maxPlanners`, `maxImplementers`, `maxReviewers` and `maxRunning` (total)
- **When** work is queued
- **Then** no limit is ever exceeded by sessions that are running (not idle)
- **And** queued work starts in this order: Feedback rounds, then Reviews, then approved issues (oldest approval first), then planning
- **And** continuing an interrupted session comes before all of these, an Owner `/wake` ranks with Feedback rounds, and a plan revision ranks with planning; within a rank, the oldest queued work starts first
- **And** work for a session that is running is held back until it is idle

### REQ-001-09 Implementation run

- **Given** an approved, unblocked issue and a free Slot
- **When** the Implementer starts
- **Then** it runs as a fresh session in a new Worktree on branch `agent/<issue>-<slug>`, created from the default branch
- **And** its context is limited to the issue, the approved Assessment, the approval notes and the Coordination notes
- **And** when it finishes, the Coordinator pushes the branch and opens a PR containing the AGENTS.md note header and `Closes #<issue>`
- **And** the label changes from `agent:in-progress` to `agent:pr-open`

### REQ-001-10 Review run

- **Given** an open agent PR whose head commit has not been reviewed and whose checks have all passed (or which has no checks)
- **When** a reviewer Slot is free
- **Then** a fresh Reviewer session runs read-only on a checkout of the PR head, with no access to the Implementer's session
- **And** the Coordinator posts its findings as one PR review with inline comments
- **And** the review event is always `COMMENT`, never `APPROVE` or `REQUEST_CHANGES`

### REQ-001-11 Blocking findings trigger a Feedback round

- **Given** a Review with at least one finding marked blocking
- **When** it has been posted
- **Then** the Implementer session is resumed in its Worktree with those findings, and the new commits are pushed to the same PR (which in turn triggers a new Review)
- **And** after `maxFeedbackRounds` automatic rounds on a PR, it is labelled `agent:failed` instead
- **And** a Review without blocking findings labels the PR `agent:reviewed`

### REQ-001-12 Owner feedback on a PR

- **Given** an open agent PR
- **When** the Owner comments `/agent <text>` or submits a "changes requested" review
- **Then** a Feedback round runs with that text, without counting toward `maxFeedbackRounds`

### REQ-001-13 Failing checks trigger a Feedback round

- **Given** an open agent PR
- **When** its checks fail
- **Then** a Feedback round runs with the failing check output, counted toward `maxFeedbackRounds`

### REQ-001-14 Cleanup

- **Given** an agent PR
- **When** it is merged or closed
- **Then** its Worktree and local branch are removed, its sessions are closed, and the issue's agent labels are cleared

### REQ-001-15 Least privilege

- **Given** any agent session
- **When** it runs
- **Then** it has no GitHub write credential: the Coordinator performs every comment, label, review, push and PR action
- **And** the Coordinator's GitHub identity cannot update a repository's default branch

### REQ-001-16 Restart safety

- **Given** the Coordinator restarts while sessions were running
- **When** it starts up
- **Then** it rebuilds state from labels and its local store
- **And** each interrupted session is resumed once or labelled `agent:failed`

### REQ-001-17 Usage limit

- **Given** a session stops because the subscription usage limit was reached
- **When** the Coordinator schedules work
- **Then** it starts no new sessions until the reported reset time and continues the interrupted one afterwards

### REQ-001-18 Sessions available on the Owner's phone

- **Given** the Coordinator starts or resumes any agent session
- **When** the session is running or idle
- **Then** it is registered with Remote Control under the name `<repo>#<issue> <role>` (a batch Planner session: `<repo> planner`), with no manual step
- **And** the Owner can follow it live and send messages to it from the Claude app

### REQ-001-19 Owner chat is synced and never interrupted

- **Given** a live session
- **When** the Owner has sent it a message and it has not yet finished replying
- **Then** the Coordinator does not inject any prompt into it or close it
- **And** after any turn ends (Coordinator- or Owner-initiated), the Coordinator syncs the Result to GitHub: the Planner's turns edit the Assessment, and the Implementer's turns push new commits and update the PR body

### REQ-001-27 A failed sync is retried, then reported

- **Given** a turn that ended, whose Result could not be synced to GitHub (e.g. creating the PR was refused)
- **When** the Coordinator reconciles again
- **Then** it retries the sync, with the session open or closed
- **And** after 3 failed attempts in a row it labels the issues `agent:failed` with a comment naming the last error, instead of leaving them in flight

### REQ-001-20 Idle sessions are closed

- **Given** a session that has been idle longer than `idleTimeoutMin`, or more live sessions (running and idle together) than `maxLiveSessions`
- **When** the Coordinator reconciles, or needs room to start or resume a session
- **Then** it closes idle sessions until the limit holds, never a running one, and starts nothing new while the limit is reached and no idle session can be closed
- **And** it closes them in this order: first sessions waiting on the Owner on GitHub (Planner sessions awaiting a decision), then other idle sessions, and last Implementer sessions whose PR is in a Feedback round and sessions the Owner messaged within the last `idleTimeoutMin`; least recently used first within each group
- **And** a closed session is resumed (and registered with Remote Control again) when it next has work

### REQ-001-23 Reviewer sessions are short-lived

- **Given** a Reviewer session whose Result is valid
- **When** its Review has been posted
- **Then** the session is closed right away

### REQ-001-24 Owner wakes a closed session

- **Given** a closed Planner or Implementer session of an issue or agent PR
- **When** the Owner comments `/wake` on that issue or PR
- **Then** the session is resumed (and registered with Remote Control again) with a prompt saying the Owner wants to chat, without changing labels or counting toward `maxFeedbackRounds`
- **And** it counts toward the limits like any other session

### REQ-001-21 Valid Result required

- **Given** a session's turn is ending
- **When** its Result file is missing or does not match the Role's schema
- **Then** the session is told what is wrong and continues instead of ending
- **And** after 3 failed attempts, the issue is labelled `agent:failed`

### REQ-001-22 Per-Role model and prompt

- **Given** a model (and optional effort) and a prompt configured for each Role (Planner, Implementer, Reviewer), optionally overridden per repository
- **When** a session of that Role starts or resumes
- **Then** it uses the configured model and that Role's prompt
- **And** a repository can replace a Role's default prompt with its own

### REQ-001-25 Sessions don't wait for routine permission

- **Given** a Planner or Reviewer session
- **When** it tries to use a tool
- **Then** it may only read the repository, run read-only git commands, search the web, read web pages and write its Result; anything else is denied without asking
- **And** given an Implementer session, Claude Code's auto mode decides on routine actions without asking, and anything it will not allow on its own is left for the Owner to approve or refuse in the Claude app
- **And** an Implementer's shell commands run in Claude Code's sandbox, and never unsandboxed: without a working sandbox the session runs no commands at all
- **And** inside the sandbox, an Implementer's shell commands can reach only the network domains configured for the repository (by default, the common package registries)

### REQ-001-26 Agents can't read the Coordinator's secrets

- **Given** any agent session
- **When** it tries to read the GitHub App's private key or Claude Code's login credentials, with a file tool or a shell command
- **Then** the read is denied

## Out of scope

- Webhooks (polling only for now; webhooks may later be added only to trigger a poll sooner).
- Reviewing PRs not opened by the Coordinator (possible later as a per-repo option).
- Notifications other than GitHub's own and the Claude app.
- Issues by anyone except the Owner; multiple human users.

## Assumptions

- Agents run on the Owner's Claude Pro subscription. The `agent` user is logged in once during setup (`/login`). This quota is shared with the Owner's own use, and the plan determines which models are available.
- Sessions run as interactive `claude --remote-control <name> "<prompt>"` processes inside detached tmux windows that the Coordinator owns. The Owner never needs to use tmux.
- Turn boundaries and Owner activity are detected with Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) passed through `--settings`. The hooks also fire for messages sent from the phone. The Result is a JSON file that the `Stop` hook validates. All of this was verified in T0 (Claude Code 2.1.322).
- A resumed session keeps its session id and its Remote Control conversation, so the Owner keeps the same chat on the phone (verified in T0).
- New directories trigger a folder trust dialog, which the runner answers (see `docs/known-pitfalls.md`).
- The Coordinator's GitHub identity is a private GitHub App. Each target repository has a ruleset on its default branch that only the Owner can bypass.
- The existing GitHub Actions review workflow is disabled in repositories the Coordinator manages.

## Verification

Partial rows: the REQ is only covered for the parts built so far (noted in brackets); its behaviour end to end is tested once the scheduler and runners exist.

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Result                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| REQ-001-01 | `config > REQ-001-01 requires the Owner's login …`, `… at least one repository …`; `deriveActions > REQ-001-01 ignores issues by anyone but the Owner, and PRs`; `GitHub client > REQ-001-01 lists open issues and PRs with their author's numeric id …`, `… lists comments with author ids …`                                                                                                                                                                                                      | partial (config, GitHub client, derivation): pass                                               |
| REQ-001-02 | `deriveActions > REQ-001-02 queues every new Owner issue …`; `Assessment comment > REQ-001-02 …` (2 tests); `Planner pass > REQ-001-02 labels the issues agent:planning and starts one batch Planner session …`, `… posts one Assessment per issue, sets the verdict label, and closes the batch session`           ; `reconcile loop > REQ-001-02 / REQ-001-07 plans new Owner issues once …`                                                                                                      | pass                                                                                            |
| REQ-001-03 | `deriveActions > REQ-001-03 …` (2 tests); `plan revision > REQ-001-03 …` (3 tests: fresh per-issue session after a batch, resume and body edit, comment edited in place)                                                                                                                                            ; `reconcile loop > REQ-001-03 an Owner comment on a proposal revises the plan …`                                                                                               | pass                                                                                            |
| REQ-001-04 | `GitHub client > REQ-001-04 finds who added a label most recently …`; `deriveActions > REQ-001-04 …` (4 tests: /approve with notes, not by others or on other states, label by the Owner, label by anyone else, approval on record); `reconcile loop > REQ-001-04 …` (2 tests)                                                                                                                                                                                                                      | pass                                                                                            |
| REQ-001-05 | `deriveActions > REQ-001-05 …` (2 tests); `reconcile loop > REQ-001-05 an approved issue waits as agent:blocked until its blocker is closed`                                                                                                                                                                                                                                                                                                                                                        | pass                                                                                            |
| REQ-001-06 | `deriveActions > REQ-001-06 a Bundle takes in the open issues it is bundled with, once`; `Implementer run > REQ-001-06 / REQ-001-09 labels the Bundle in progress …`, `… opens a PR … that closes every issue`                                                                                                                                                                                                                                                                                      | pass                                                                                            |
| REQ-001-07 | `deriveActions > REQ-001-07 starts nothing for an issue labelled … while its … session is live` (planning, in-progress, reviewing), `… finds a batch Planner session through any of its issues`                                                                                                                     ; `reconcile loop > REQ-001-02 / REQ-001-07 …`                                                                                                                                  | pass                                                                                            |
| REQ-001-08 | `config > REQ-001-08 rejects limits …`, `… allows zero feedback rounds`; `scheduler > REQ-001-08 starts work in priority order …`, `… oldest approval first`, `… never exceeds a Role's Slots or the total …`, `… lower-priority work for a free Role starts …`, `… holds back work for a session that is running …`; `reconcile loop > REQ-001-08 limits apply across repositories …`                                                                                                              | pass                                                                                            |
| REQ-001-09 | `worktrees > REQ-001-09 …` (3 tests); `deriveActions > REQ-001-09 an approved, unblocked issue …`; `Implementer run > REQ-001-09 …` (3 tests: start, limited context, push and PR); `reconcile loop > REQ-001-09 / REQ-001-14 …`                                                                                                                                                                                                                                                                    | pass                                                                                            |
| REQ-001-10 | `GitHub client > REQ-001-10 posts a Review … always with event COMMENT`, `… reads a PR's head commit …`, `… summarises check runs …`; `worktrees > REQ-001-10 review checkouts …`; `deriveActions > REQ-001-10 …` (4 tests); `Reviewer run > REQ-001-10 …` (2 tests); `reconcile loop > REQ-001-10 / REQ-001-23 …`                                                                                                                                                                                  | pass                                                                                            |
| REQ-001-11 | `Reviewer run > REQ-001-11 …` (2 tests); `deriveActions > REQ-001-11 …` (2 tests: counted round, agent:failed past the limit); `Implementer run > REQ-001-11 …` (3 tests: resume, fresh session, back to agent:pr-open); `reconcile loop > REQ-001-11 …` (2 tests)                                                                                                                                                                                                                                  | pass                                                                                            |
| REQ-001-12 | `GitHub client > REQ-001-12 lists PR reviews …`; `deriveActions > REQ-001-12 the Owner's /agent comment or changes-requested review starts an uncounted round, even past the limit`, `REQ-001-10 / REQ-001-12 no Review of a head …`; `reconcile loop > REQ-001-12 …`                                                                                                                                                                                                                               | pass                                                                                            |
| REQ-001-13 | `GitHub client > REQ-001-13 failed checks carry their output summary`; `deriveActions > REQ-001-13 …`; `reconcile loop > REQ-001-13 failing checks start a round with their output, once per head`                                                                                                                                                                                                                                                                                                  | pass                                                                                            |
| REQ-001-14 | `worktrees > REQ-001-14 …`; `store > REQ-001-14 lists Worktrees on record …`; `deriveActions > REQ-001-14 …`; `Implementer run > REQ-001-14 cleanup …`, `REQ-001-19 cleanup waits …`; `reconcile loop > REQ-001-09 / REQ-001-14 …`                                                                                                                                                                                                                                                                  | pass                                                                                            |
| REQ-001-15 | `config > REQ-001-15 requires the GitHub App's id …`; `GitHub App auth > REQ-001-15 signs an RS256 app JWT …`, `… mints an installation token per repository …`                                                                                                                                                     ; `main clones > REQ-001-15 never stores the token in the clone`, `… passes the token as a one-off HTTP header`                                                                 | partial (config, GitHub auth): pass                                                             |
| REQ-001-16 | `deriveActions > REQ-001-16 resumes an interrupted session once …`, `… labels the issue agent:failed when …` (3 cases), `… idle … is just marked closed`; `store > REQ-001-16 keeps sessions across a restart`                                                                                                      ; `session runner > REQ-001-16 a session still marked running whose window is gone …`; `reconcile loop > REQ-001-16 resumes a session interrupted by a restart once …`          | pass                                                                                            |
| REQ-001-17 | `scheduler > REQ-001-17 starts nothing while the usage limit pause lasts …`; `store > REQ-001-17 keeps the usage-limit pause …`; `hook > REQ-001-17 a turn cut off by the usage limit is not blocked …`                                                                                                             ; `reconcile loop > REQ-001-17 pauses after the usage limit, then continues …`                                                                                                  | partial (detection unverified against a real limit; pausing wired up in the loop): pass         |
| REQ-001-18 | `claude command line > REQ-001-18 …` (2 tests); `session runner > REQ-001-18 starts a session in its own tmux window …`; `hook > REQ-001-18 SessionStart records Claude's session id …`; manual: `bun scripts/smoke-runner.ts` (2026-11-10, haiku)                                                                                                                                                                                                                                                  | pass                                                                                            |
| REQ-001-19 | `hook > REQ-001-19 …` (3 tests); `session runner > REQ-001-19 …`; `plan revision > REQ-001-19 …`; `Implementer run > REQ-001-19 later turns, including the Owner's, push new commits and update the PR body`, `… cleanup waits while the Owner is chatting …`                                                                                                                                                                                                                                       | pass                                                                                            |
| REQ-001-20 | `config > REQ-001-20 rejects maxRunning above maxLiveSessions …`; `scheduler > REQ-001-20 …` (8 tests); `session runner > REQ-001-20 closes an idle session by killing its window`, `… resumes a closed or idle session with --resume …`                                                                            ; `reconcile loop > REQ-001-20 closes sessions idle longer than idleTimeoutMin`                                                                                                 | pass                                                                                            |
| REQ-001-21 | `Result validation > REQ-001-21 …` (4 tests); `hook > REQ-001-21 …` (3 tests); `Planner pass > REQ-001-21 a session that gave up on its Result labels its issues agent:failed`                                                                                                                                                                                                                                                                                                                      | partial (Implementer and Reviewer in T11/T12): pass                                             |
| REQ-001-22 | `config > REQ-001-22 …` (3 tests); `prompts > REQ-001-22 each Role has a default prompt`, `… a repository can replace a Role's prompt …`; `claude command line > REQ-001-18 / REQ-001-22 …`                                                                                                                                                                                                                                                                                                         | pass                                                                                            |
| REQ-001-23 | `Reviewer run > REQ-001-10 / REQ-001-23 posts one COMMENT review … then closes the session and its checkout`; `reconcile loop > REQ-001-10 / REQ-001-23 …`                                                                                                                                                                                                                                                                                                                                          | pass                                                                                            |
| REQ-001-24 | `session runner > REQ-001-24 a wake keeps the existing Result file`; `deriveActions > REQ-001-24 …`; `reconcile loop > REQ-001-24 /wake on a PR resumes its closed Implementer session …`                                                                                                                                                                                                                                                                                                           | pass                                                                                            |
| REQ-001-25 | `permissions > REQ-001-25 …` (2 tests, incl. WebSearch/WebFetch for Planner and Reviewer); `config > REQ-001-25 sandbox network domains default to the common package registries …`; `session runner > REQ-001-25 …` (2 tests: modes, sandbox and network per Role, kept on resume); manual: smoke runs 2026-11-11 (reviewer write denied; implementer Bash/commit, sandbox was silently off then), 2026-11-12 (`claude -p --permission-mode dontAsk --allowedTools WebSearch …`: search succeeded) | partial (sandboxed Bash blocked by Ubuntu AppArmor until docs/setup.md step 1 is applied): pass |
| REQ-001-26 | `session runner > REQ-001-26 every Role is denied reading the Coordinator's secrets, with file tools and in shell commands`                                                                                                                                                                                                                                                                                                                                                                         | partial (not yet observed in a live sandboxed session): pass                                    |
| REQ-001-27 | `reconcile loop > REQ-001-27 a failed sync is retried on the next tick`, `… retried after its session was closed, without failing the issue`, `… after 3 failed syncs in a row the issue is labelled agent:failed with the error`                                                                                                                                                                                                                                                                   | pass                                                                                            |
