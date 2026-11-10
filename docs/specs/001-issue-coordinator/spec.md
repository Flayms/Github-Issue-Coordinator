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

### REQ-001-03 Plan revision on Owner feedback

- **Given** an issue labelled `agent:proposed`, `agent:needs-refinement` or `agent:wontfix-proposed`
- **When** the Owner posts a comment that is not a command, or edits the issue body
- **Then** the Planner session for that issue is resumed with the feedback
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
- **Then** it is registered with Remote Control under the name `<repo>#<issue> <role>`, with no manual step
- **And** the Owner can follow it live and send messages to it from the Claude app

### REQ-001-19 Owner chat is synced and never interrupted

- **Given** a live session
- **When** the Owner has sent it a message and it has not yet finished replying
- **Then** the Coordinator does not inject any prompt into it or close it
- **And** after any turn ends (Coordinator- or Owner-initiated), the Coordinator syncs the Result to GitHub: the Planner's turns edit the Assessment, and the Implementer's turns push new commits and update the PR body

### REQ-001-20 Idle sessions are closed

- **Given** a session that has been idle longer than `idleTimeoutMin`, or more idle sessions than `maxLiveSessions`
- **When** the Coordinator reconciles
- **Then** it closes the least recently used idle sessions
- **And** a closed session is resumed (and registered with Remote Control again) when it next has work

### REQ-001-21 Valid Result required

- **Given** a session's turn is ending
- **When** its Result file is missing or does not match the Role's schema
- **Then** the session is told what is wrong and continues instead of ending
- **And** after 3 failed attempts, the issue is labelled `agent:failed`

### REQ-001-22 Per-Role model and prompt

- **Given** a model (and optional effort) and a prompt configured for each Role (Planner, Implementer, Reviewer), optionally overridden per repository
- **When** a session of that Role starts or resumes
- **Then** it uses the configured model and that Role's prompt

## Out of scope

- Webhooks (polling only for now; webhooks may later be added only to trigger a poll sooner).
- Reviewing PRs not opened by the Coordinator (possible later as a per-repo option).
- Notifications other than GitHub's own and the Claude app.
- Issues by anyone except the Owner; multiple human users.

## Assumptions

- Agents run on the Owner's Claude Pro subscription. The `agent` user is logged in once during setup (`/login`). This quota is shared with the Owner's own use, and the plan determines which models are available.
- Sessions run as interactive `claude --remote-control <name> "<prompt>"` processes inside detached tmux windows that the Coordinator owns. The Owner never needs to use tmux.
- Turn boundaries and Owner activity are detected with Claude Code hooks (`Stop`, `UserPromptSubmit`) passed through `--settings`. The Result is a JSON file that the `Stop` hook validates. All of this is verified by plan task T0.
- The Coordinator's GitHub identity is a private GitHub App. Each target repository has a ruleset on its default branch that only the Owner can bypass.
- The existing GitHub Actions review workflow is disabled in repositories the Coordinator manages.

## Verification

| REQ | Test | Result |
| --- | ---- | ------ |
