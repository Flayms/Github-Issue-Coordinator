# 001 – Issue coordinator

**Status:** Draft

## Goal

The Owner (the single human user) wants GitHub issues across their public and private repositories triaged, planned, implemented and reviewed by Claude Code agents running on their own server. Agents must be stateful per issue and stay within an explicit approval gate. The Owner steers everything through GitHub (labels, comments). Every agent session also shows up automatically in the Claude app on their phone, so they can follow it live and chat with it, without ever running a command on the server.

## Requirements

### REQ-001-01 Repository and author scope

- **Given** a list of configured repositories
- **When** the Coordinator polls
- **Then** it considers only issues authored by the Owner, and Split-off issues the Coordinator created itself (REQ-001-34)
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
- **When** the Owner posts a comment that is not a command
- **Then** that issue's own Planner session is resumed with the comment, or started fresh with the issue and its current Assessment as context if it has none yet
- **And** the Assessment comment is edited in place (not duplicated) and the label updated to the revised verdict, which may be any of the three
- **And** the Owner gets a Reply (REQ-001-40)
- **And** the Owner can give feedback again on every revised Assessment
- An edited issue body is planned from scratch instead (REQ-001-41).

### REQ-001-04 Approval only by the Owner on GitHub

- **Given** an issue labelled `agent:proposed`
- **When** the Owner adds `agent:approved` or comments `/approve [notes]`
- **Then** the issue becomes approved, and any notes are passed to the Implementer
- **And** when anyone else adds `agent:approved`, the Coordinator removes the label and does not start an Implementer
- **And** nothing said inside an agent session counts as approval

### REQ-001-05 Blocked issues are held back

- **Given** an issue whose Assessment lists "blocked by #N" and #N is open
- **When** the Owner approves it (REQ-001-04)
- **Then** it goes straight to `agent:blocked` instead of `agent:approved`, and does not start
- **And** an approved issue that becomes blocked before it starts (e.g. #N is reopened) also gets `agent:blocked`
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
- **And** when it finishes, the Coordinator pushes the branch and opens a draft PR (REQ-001-31) containing the agent note (REQ-001-29) and `Closes #<issue>`
- **And** the issue is labelled `agent:in-progress` while the Implementer runs, and `agent:pr-open` once the PR is open

### REQ-001-10 Review run

- **Given** an open agent PR whose head commit has not been reviewed, which GitHub reports as mergeable (not conflicting, and no longer being computed), and whose checks have all passed
- **Or** which has no checks, and `checksGraceSeconds` (default 120) have passed since the Coordinator first saw its head commit, so CI had time to register its runs
- **When** a reviewer Slot is free
- **Then** a fresh Reviewer session runs read-only on a checkout of the PR head, with no access to the Implementer's session
- **And** the Coordinator posts its findings as one PR review with inline comments
- **And** the review event is always `COMMENT`, never `APPROVE` or `REQUEST_CHANGES`
- **And** the issue is labelled `agent:reviewing` while the Reviewer runs, then `agent:reviewed` (no findings, REQ-001-11) or `agent:pr-open` (findings)

### REQ-001-11 Review findings trigger a Feedback round

- **Given** a Review with at least one finding (every finding a Review posts is one to fix, REQ-002-09)
- **When** it has been posted
- **Then** the Implementer session is resumed in its Worktree with all of its findings, numbered, and the new commits are pushed to the same PR (which in turn triggers a new Review)
- **And** after `maxFeedbackRounds` automatic rounds on a PR, it is labelled `agent:failed` instead, once per head commit
- **And** a Review without findings labels the PR `agent:reviewed`
- **And** during any Feedback round (this one, REQ-001-12, REQ-001-13, REQ-001-28) the issue is labelled `agent:in-progress`, and `agent:pr-open` again once the round's turn is synced
- **And** until its Feedback round starts, the issue is labelled `agent:in-progress` (REQ-001-39)

### REQ-001-12 Owner feedback on a PR

- **Given** an open agent PR
- **When** the Owner comments `/agent <text>` or submits a "changes requested" review
- **Then** a Feedback round runs with that text, without counting toward `maxFeedbackRounds`

### REQ-001-13 Failing checks trigger a Feedback round

- **Given** an open agent PR
- **When** its checks fail
- **Then** a Feedback round runs with the failing check output, counted toward `maxFeedbackRounds`
- **And** this happens once per head commit; past the limit the PR is labelled `agent:failed`, also once per head commit

### REQ-001-28 Merge conflicts trigger a Feedback round

- **Given** an open agent PR that GitHub reports as not mergeable (merge conflicts with its base branch)
- **When** the Coordinator reconciles
- **Then** it fetches the default branch into the Worktree and runs a Feedback round asking the Implementer to merge it (merge, not rebase, so the push stays a fast-forward) and resolve the conflicts
- **And** this happens once per head commit and does not count toward `maxFeedbackRounds` (main moving is not the agent's fault), so it also runs past the limit; the merge commit is a new head, which goes back to draft and gets a Review (REQ-001-31)
- **And** no Review runs while the PR has conflicts
- **And** no automatic round of any kind runs while the issue is labelled `agent:failed`; then only the Owner's rounds do (REQ-001-37)

### REQ-001-14 Cleanup

- **Given** an agent PR on record with a Worktree
- **When** GitHub reports that PR itself as merged or closed
- **Then** its Worktree and local branch are removed, its sessions are closed, the issue's agent labels are cleared, and the PR is no longer on record for the issue
- **And** an issue whose PR was closed without merging is open again without an agent label, so it is planned anew (REQ-001-02)
- **And** a PR that is only missing from the list of open items (cached or lagging) is not cleaned up, and keeps getting Reviews and Feedback rounds; if the PR can't be fetched, nothing is decided about it until a later tick

### REQ-001-15 Least privilege

- **Given** any agent session
- **When** it runs
- **Then** it has no GitHub write credential: the Coordinator performs every comment, label, review, push and PR action
- **And** the Coordinator's GitHub identity cannot update a repository's default branch

### REQ-001-16 Restart safety

- **Given** the Coordinator restarts while sessions were running
- **When** it starts up
- **Then** it rebuilds state from labels and its local store
- **And** when an issue carries several agent labels, the most advanced one counts, `agent:failed` above all
- **And** each interrupted session is resumed once or labelled `agent:failed`
- **And** an interrupted session that has no Claude session id gets `agent:failed` with "the session exited before Claude Code started", since it cannot be resumed

### REQ-001-17 Usage limit per Account

- **Given** a session stops because its Account (spec 004) reached the subscription usage limit
- **When** the Coordinator schedules work
- **Then** that Account is paused until the reported reset time (30 minutes while the reset time can't be read) and no session starts or resumes on it
- **And** the interrupted session continues right away on another Account that isn't paused
- **And** only while every Account is paused does new work wait, until the first Account is free again; with one Account this is the whole pause, as before

### REQ-001-18 Sessions available on the Owner's phone

- **Given** the Coordinator starts or resumes any agent session
- **When** the session is running or idle
- **Then** it is registered with Remote Control under a name that shows its context (REQ-001-33), with no manual step
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
- **And** when one of its shell commands writes a file (e.g. `git log --output=<file>`), the write is denied everywhere except its session folder and the sandbox's temporary folder
- **And** given an Implementer session, Claude Code's auto mode decides on routine actions without asking, and anything it will not allow on its own is left for the Owner to approve or refuse in the Claude app
- **And** an Implementer's shell commands run in Claude Code's sandbox, and never unsandboxed: without a working sandbox the session runs no commands at all
- **And** inside the sandbox, an Implementer's shell commands can reach only the network domains configured for the repository (by default, the common package registries)

### REQ-001-26 Agents can't read the Coordinator's secrets

- **Given** any agent session
- **When** it tries to read the GitHub App's private key or Claude Code's login credentials (of every Account, REQ-004-02), with a file tool or a shell command
- **Then** the read is denied

### REQ-001-29 Agent note names the model and the Role

- **Given** a comment, PR or review the Coordinator posts on behalf of the Owner
- **When** it was written by a Role's session
- **Then** it starts with `> [!Note]` followed by `> 🤖 Claude <Model> (<Role>) writing on behalf of <Owner>`, e.g. `Claude Opus 5.5 (Planner)`
- **And** `<Model>` is the family and version of the model the session actually ran (e.g. `Opus 5.5` for `claude-opus-5-5`), and `<Role>` is `Planner`, `Implementer` or `Reviewer`
- **And** if the model's version is unknown, it names the configured model instead (e.g. `Claude Opus`), never the Role
- **Given** a message the Coordinator posts on its own (e.g. giving up on an issue)
- **Then** it starts with `> [!Note]` followed by `> 🤖 Coordinator writing on behalf of <Owner>`, and names the Role of the failed session, if any, in the body

### REQ-001-30 An Implementer's shell commands write only inside its Worktree

- **Given** an Implementer session
- **When** one of its shell commands writes a file
- **Then** the write succeeds inside its Worktree (including commits to the Worktree's own git history), its session folder and the sandbox's temporary folder
- **And** a write anywhere else is denied

### REQ-001-31 Agent PRs stay drafts until reviewed

- **Given** an agent PR
- **When** the Coordinator opens it
- **Then** it is a draft, so it can't be merged before its Review
- **When** a Review of its head has no findings
- **Then** it is marked ready for review
- **When** a later turn (a Feedback round or the Owner's chat) pushes a head that was not reviewed
- **Then** it goes back to draft until that head has a Review without findings
- **When** an automatic Feedback round ends without new commits (REQ-001-38)
- **Then** the PR keeps its draft state, the issue is labelled `agent:pr-open`, and it waits for the Owner: `/agent <text>` starts a round to fix it anyway (REQ-001-12), or the Owner marks it ready or merges it by hand
- **When** it is labelled `agent:failed`
- **Then** it is (or goes back to) a draft
- **And** the Owner can still mark it ready for review by hand

### REQ-001-32 The Owner may delete an Assessment comment

- **Given** an issue whose Assessment comment the Owner deleted on GitHub
- **When** the Planner's Result for it is synced
- **Then** the Coordinator posts the Assessment as a new comment and edits that one from then on
- **And** the sync does not fail

### REQ-001-33 Session names show the context

- **Given** a session for one issue or a Bundle
- **When** it is started or resumed
- **Then** its Remote Control name is `#<issue> <issue title> · <Role> · <repository name>`, e.g. `#16 better chat names · Implementer · Github-Issue-Coordinator`
- **And** a Bundle's session names its first issue and adds ` (+<k>)` for the other `k` issues
- **And** a title longer than 50 characters is cut to 49 characters followed by `…`
- **And** a resume keeps the name
- **Given** a batch Planner session
- **Then** its name is `Planner · #<a>, #<b>, … · <repository name>`
- **Given** a session started before titles were stored
- **Then** it keeps its old name `<repo>#<issue> <role>`

### REQ-001-34 The Planner can split off issues

- **Given** a Planner Result whose entry for issue #N lists Split-off issues (title, body), at most 5
- **When** the Coordinator syncs it
- **Then** it creates each one on GitHub with its own identity; each body starts with the agent note (REQ-001-29) and says "Split off from #N"
- **And** the Assessment of #N lists the created issues by number under **Coordination**
- **And** an issue listed again for #N (same title, ignoring case and surrounding spaces), in the same Result or a later revision, is not created a second time
- **And** Split-off issues created earlier are never closed or edited automatically, even when a revision no longer lists them
- **Given** a Split-off issue
- **Then** it is in scope like an Owner issue (REQ-001-01): planned on the next pass, and approved only by the Owner (REQ-001-04)
- **And** no agent session gets a GitHub credential for this (REQ-001-15)

### REQ-001-35 The Implementer answers each Review finding

- **Given** a Feedback round with Review findings
- **When** the Implementer's turn ends
- **Then** its Result answers each finding, by its number, with `fixed` or `declined` and a reason; a Result that leaves a finding unanswered is not valid (REQ-001-21)
- **And** the Coordinator posts the answers as one PR comment with the agent note, each finding quoted next to its answer
- **And** when an automatic round produced no new commits, the same comment says why the PR waits for the Owner (REQ-001-38), instead of a second comment

### REQ-001-36 A re-review sees what came before

- **Given** a PR that already had a Review and a Feedback round with answers (REQ-001-35)
- **When** it is reviewed again
- **Then** the Reviewer's context holds the earlier findings and the Implementer's answers
- **And** the Reviewer raises a declined finding again only if it says why the reason is wrong

### REQ-001-37 The Owner can have merge conflicts fixed

- **Given** an open agent PR that GitHub reports as not mergeable, also when it is labelled `agent:failed` or a merge conflict round already ran at its head
- **When** the Owner starts a Feedback round (`/agent <text>` or a changes-requested review, REQ-001-12)
- **Then** the Coordinator first fetches the default branch into the Worktree and adds the merge instruction (REQ-001-28) to the round's text
- **And** the round does not count toward `maxFeedbackRounds`
- **And** `agent:failed` is removed from the issue and the PR

### REQ-001-38 A stalled PR tells the Owner

- **Given** an automatic Feedback round (Review findings, failing checks or merge conflicts)
- **When** it ends without a new head commit
- **Then** the Coordinator posts one PR comment with the agent note that names why it stalled (findings declined or not fixed, checks still failing, still conflicting) and what the Owner can do: `/agent <text>`, mark it ready for review by hand, or merge it by hand
- **And** on a round with Review findings, this is part of the answers comment (REQ-001-35)
- **And** the issue goes back to `agent:pr-open` and the PR keeps its draft state (REQ-001-31)
- **And** a round the Owner started posts no such comment
### REQ-001-39 Review findings go straight back to the Implementer

- **Given** a Review with at least one finding
- **When** it has been posted
- **Then** the issue's label changes from `agent:reviewing` to `agent:in-progress`, without `agent:pr-open` in between
- **And** the issue stays `agent:in-progress` until its Feedback round starts, even while the round waits for a Slot or the Coordinator restarts; it does not count as an issue without its session (REQ-001-07, REQ-001-16)
- **And** past `maxFeedbackRounds` it is labelled `agent:failed` as before (REQ-001-11)

### REQ-001-40 The Planner answers feedback comments

- **Given** an Assessment revised because the Owner commented (REQ-001-03, or REQ-001-41 with comments from the same poll)
- **When** the Coordinator syncs the Planner's Result
- **Then** it edits the Assessment in place and posts one new comment, the Reply, below the Owner's comments
- **And** the Reply starts with the agent note (REQ-001-29), links the Owner's comments and the Assessment, and says in a few lines what changed and why, or why nothing changed
- **And** the Reply is posted even when the Assessment itself did not change
- **And** if the Result gives no reply text, the Reply says in one line that the feedback was taken into account, with the same links
- **And** a Reply is posted once, also when the sync is retried (REQ-001-27)
- **Given** a Planner turn no feedback comment started (a first pass, a body edit only, the Owner chatting through Remote Control)
- **Then** no Reply is posted

### REQ-001-41 An edited issue is planned from scratch

- **Given** an issue labelled `agent:proposed`, `agent:needs-refinement` or `agent:wontfix-proposed`
- **When** the Owner edits its description
- **Then** the Coordinator closes any live Planner session of that issue and starts a fresh Planner session for it, with all in-scope open issues and open PRs as context like a pass (REQ-001-02)
- **And** that session gets neither the old Assessment nor the old session
- **And** the new Assessment replaces the old one in the same comment, the label is updated, and no Reply is posted
- **And** comments the Owner posted in the same poll go into the fresh session as feedback and get a Reply (REQ-001-40)
- **And** Split-off issues created earlier are not created again (REQ-001-34)

### REQ-001-42 An open agent PR keeps its issue out of planning

- **Given** an open issue in scope with an open agent PR: a PR from a branch `agent/<n>-…` of the same repository (never a fork, whatever its branch is called) that is named after the issue or closes it (`Closes #<issue>`, `Fixes …`, `Resolves …`)
- **When** the Coordinator decides what to do
- **Then** no Planner pass and no Implementer run starts for that issue, even if it has no agent label, a Planner verdict label or `agent:approved`

### REQ-001-43 An orphaned agent PR is re-attached

- **Given** an open agent PR (REQ-001-42) with open issues in scope, no Worktree on record for any of them and no open session for any of them
- **When** the Coordinator polls and GitHub reports the PR itself as open
- **Then** it rebuilds the Worktree from the PR's branch, tracking it on the remote, records the PR and Worktree for those issues again, and labels them `agent:pr-open` alone (removing every other agent label, stale `agent:failed` and in-flight labels too), so the PR gets Reviews and Feedback rounds again (REQ-001-10/11/28)
- **And** a stale in-flight label on an issue being re-attached does not make it `agent:failed` for a missing session (REQ-001-07)
- **And** it posts one comment with the agent note on the PR saying it was re-attached
- **And** while `maxWorktrees` is reached, or a folder already exists where the Worktree would go, it re-attaches nothing and tries again on a later tick
- **And** when all the PR's issues are closed or out of scope it does nothing and logs that once

### REQ-001-44 A session that cannot start says why

- **Given** a Planner pass, a plan revision, an Implementer run, a Feedback round, a Review, or a resume of any session
- **When** its session cannot be launched (e.g. tmux refuses the command)
- **Then** the session is recorded as closed, not running
- **And** its issues are labelled `agent:failed` once, with a comment naming the error; an open agent PR is labelled `agent:failed` too (REQ-001-16)
- **And** later ticks do not fail them again, neither as an interrupted session (REQ-001-16) nor as an issue without its session (REQ-001-07), and no Review is started while an issue is `agent:failed`
- **And** for a plan revision, the Owner's comments and description edit stay unhandled, so the revision gets them once the Owner removes `agent:failed`

### REQ-001-45 Prompts of any length reach the session

- **Given** a prompt longer than tmux accepts in one command (about 16 KB), e.g. a revision with a long Assessment
- **When** a session is started or resumed with it
- **Then** `claude` gets the whole prompt as one argument
- **And** the prompt's content is never interpreted by a shell (issue text is untrusted)

### REQ-001-46 The Owner is asked to review agent PRs

> **Deprecated** by REQ-001-52 (#67): the Owner wants to be the PR's assignee, not a requested reviewer.

- **Given** an agent PR
- **When** the Coordinator marks it ready for review after a Review without findings (REQ-001-31)
- **Then** it requests a review from the Owner, so the PR shows under the Owner's review requests on GitHub
- **And** this happens again each time the PR goes from draft back to ready (GitHub drops the request once the Owner submits a review)
- **And** if GitHub refuses the request, the Coordinator logs it, still marks the PR ready, and does not label anything `agent:failed`
- **And** a PR the Owner marks ready by hand gets no request

### REQ-001-52 The Owner is assigned to reviewed agent PRs

- **Given** an agent PR
- **When** the Coordinator marks it ready for review after a Review without findings (REQ-001-31)
- **Then** it adds the Owner as an assignee of the PR, so the PR shows under the Owner's assigned PRs on GitHub
- **And** it requests no review
- **And** if GitHub refuses the assignment, the Coordinator logs it, still marks the PR ready, and does not label anything `agent:failed`
- **And** a PR the Owner marks ready by hand gets no assignment
### REQ-001-47 The Planner sees the Linked history

- **Given** an issue to plan whose description, or an Owner comment the Planner gets as feedback, refers to another issue or PR in the same repository (`#N`, `owner/repo#N` or a `github.com/<owner>/<repo>/issues|pull/N` URL)
- **When** the Coordinator starts the Planner pass (REQ-001-02) or a revision turn (REQ-001-03, REQ-001-41)
- **Then** the prompt has a _Linked history_ section with, for each linked item: kind, title, state (open, closed or merged), draft status, labels, its latest timeline events with actor and time (labeled/unlabeled, ready_for_review, convert_to_draft, commits and force pushes, closed/merged/reopened), its last few Reviews (state, author, short body) and its last few comments
- **And** at most 5 linked items per issue are fetched, each item's history is capped in size, and any further links are listed as not fetched
- **And** a long list of events never crowds out the item's Reviews and latest comments
- **And** an item linked from several issues of a pass is fetched once
- **And** the issue itself and links into other repositories are not followed
- **And** a revision that resumes the issue's own session gets the history only of items the new comments link to and the description does not
- **And** if fetching an item fails, planning goes ahead and the prompt says that item could not be fetched
- **And** an issue without links gets the prompt it got before
- **And** no session gets a GitHub credential for this: the Coordinator fetches it (REQ-001-15)

### REQ-001-48 The Implementer names its Screenshots

- **Given** an Implementer turn that captured Screenshots of the pages its change affects
- **When** it writes its Result
- **Then** it may list them as `screenshots: [{path, caption}]`, with paths relative to the Worktree inside `.coordinator/screenshots/`
- **And** every Worktree's git ignores `.coordinator/` locally (not through a tracked file), so the images don't end up in the PR's commits
- **And** a Result without `screenshots` stays valid

### REQ-001-49 The Coordinator publishes Screenshots on a branch of their own

- **Given** an Implementer Result with Screenshots
- **When** the Coordinator syncs the turn (REQ-001-19) and the PR exists or has just been opened
- **Then** it commits the files to the branch `agent-screenshots` under `pr-<n>/<head-sha>/`, one commit per publish whose parent is the branch's previous tip (none for the first one), and pushes that branch
- **And** the branch shares no history with the default branch, and the Coordinator never adds the files to the default branch or the PR branch
- **And** the Implementer gets no GitHub credential for this (REQ-001-15)

### REQ-001-50 The PR shows the Screenshots

- **Given** published Screenshots
- **When** the PR body is written or updated
- **Then** a `## Screenshots` section follows `prBody`, showing each Screenshot as an image with its caption, linked by the commit of REQ-001-49, so later publishes don't change what an older body shows
- **And** a later turn without `screenshots` keeps the last section
- **And** if publishing fails, the PR is still opened or updated, and the section says the Screenshots could not be published

### REQ-001-51 Screenshot files are checked before publishing

- **Given** a Screenshot whose path leaves `.coordinator/screenshots/` of the Worktree (also through a symlink), that isn't a regular file, that isn't a PNG or JPEG by its first bytes, or that is larger than 2 MB, or a Result listing more than 5 Screenshots
- **When** the Coordinator publishes the Screenshots
- **Then** it skips that file (beyond the fifth: every further one), publishes the rest, and the section names each skipped path with the reason
- **And** the PR is still opened or updated

### REQ-001-53 A sandboxed Implementer can shoot a page

- **Given** a host with Chrome or Chromium installed (docs/setup.md)
- **When** a shell command in an Implementer session serves a page on localhost and runs the host's browser headless with `--no-sandbox` and `--screenshot`
- **Then** a non-empty PNG is written in the Worktree
- **And** this needs no new sandbox domains, and neither `allowNestedUserNamespaces` nor `allowAllUnixSockets`
- **And** `bun run doctor` reports whether the browser it finds starts headless and writes a PNG outside the sandbox, with the browser's error if not

### REQ-001-54 An agent PR shows its state

- **Given** an agent PR on record
- **When** the Coordinator sets one of the PR-phase labels on its issues: `agent:pr-open`, `agent:in-progress` (a Feedback round, or Review findings waiting for one), `agent:reviewing`, `agent:reviewed` or `agent:failed`, at any transition (the PR opened, a Review started or posted, a Feedback round started or synced, giving up, a re-attach (REQ-001-43), an Owner round clearing `agent:failed` (REQ-001-37))
- **Then** the PR gets the same label, and the other PR-phase labels are removed from it, so it carries exactly one agent label (the Coordinator puts no other agent label on a PR)
- **When** a turn outside a Feedback round pushes a new head to a reviewed PR, which goes back to draft (REQ-001-31)
- **Then** its issues and the PR lose `agent:reviewed` and get `agent:pr-open`; issues without `agent:reviewed` (e.g. `agent:failed` ones) and their PR keep their label
- **And** the PR's labels are for display only: the Coordinator never reads them to decide anything, and the issue's label stays the source of truth (REQ-001-16)
- **And** labels that are not agent labels stay on the PR

## Out of scope

- Webhooks (polling only for now; webhooks may later be added only to trigger a poll sooner).
- Reviewing PRs not opened by the Coordinator (possible later as a per-repo option).
- Notifications other than GitHub's own and the Claude app.
- Issues by anyone except the Owner; multiple human users.
- Pruning the `agent-screenshots` branch (REQ-001-49); showing Screenshots to the Reviewer; keeping the Screenshots section of a PR across a re-attach (REQ-001-43).
- Labelling agent PRs opened before REQ-001-54 right away (no backfill: a PR takes its label at its next transition); clearing the label of a merged or closed PR (REQ-001-14).

## Assumptions

- Agents run on the Owner's Claude Pro subscription. The `agent` user is logged in once during setup (`/login`). This quota is shared with the Owner's own use, and the plan determines which models are available.
- Sessions run as interactive `claude --remote-control <name> "<prompt>"` processes inside detached tmux windows that the Coordinator owns. The prompt is read from the session folder (REQ-001-45). The Owner never needs to use tmux.
- Turn boundaries and Owner activity are detected with Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`) passed through `--settings`. The hooks also fire for messages sent from the phone. The Result is a JSON file that the `Stop` hook validates. All of this was verified in T0 (Claude Code 2.1.322).
- A resumed session keeps its session id and its Remote Control conversation, so the Owner keeps the same chat on the phone (verified in T0).
- New directories trigger a folder trust dialog, which the runner answers (see `docs/known-pitfalls.md`).
- The Coordinator's GitHub identity is a private GitHub App. Each target repository has a ruleset on its default branch that only the Owner can bypass.
- The existing GitHub Actions review workflow is disabled in repositories the Coordinator manages.
- Screenshots are captured inside the Implementer's sandbox with a headless Chrome or Chromium the Owner installs once on the host (docs/setup.md); its network allowlist stays as it is. Images on the `agent-screenshots` branch of a private repository render only for viewers with access to it.

## Verification

Partial rows: the REQ is only covered for the parts built so far (noted in brackets); its behaviour end to end is tested once the scheduler and runners exist.

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Result                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| REQ-001-01 | `config > REQ-001-01 requires the Owner's login …`, `… at least one repository …`; `deriveActions > REQ-001-01 ignores issues by anyone but the Owner, and PRs`, `REQ-001-01 / REQ-001-34 a Split-off issue on record is in scope …`; `GitHub client > REQ-001-01 lists open issues and PRs with their author's numeric id …`, `… lists comments with author ids …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | partial (config, GitHub client, derivation): pass                                                                   |
| REQ-001-02 | `deriveActions > REQ-001-02 queues every new Owner issue …`; `Assessment comment > REQ-001-02 …` (2 tests); `Planner pass > REQ-001-02 labels the issues agent:planning and starts one batch Planner session …`, `… posts one Assessment per issue, sets the verdict label, and closes the batch session`           ; `reconcile loop > REQ-001-02 / REQ-001-07 plans new Owner issues once …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                                |
| REQ-001-03 | `deriveActions > REQ-001-03 …` (2 tests); `plan revision > REQ-001-03 …` (3 tests: fresh per-issue session after a batch, a later comment resumes, comment edited in place); `reconcile loop > REQ-001-03 an Owner comment on a proposal revises the plan …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass                                                                                                                |
| REQ-001-04 | `GitHub client > REQ-001-04 finds who added a label most recently …`; `deriveActions > REQ-001-04 …` (4 tests: /approve with notes, not by others or on other states, label by the Owner, label by anyone else, approval on record); `reconcile loop > REQ-001-04 …` (2 tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                                |
| REQ-001-05 | `deriveActions > REQ-001-05 …` (3 tests, incl. `an approval names the issue's open blockers, so it can go straight to agent:blocked`); `reconcile loop > REQ-001-05 an approved issue waits as agent:blocked until its blocker is closed` (straight from `/approve`, never `agent:approved` first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | pass                                                                                                                |
| REQ-001-06 | `deriveActions > REQ-001-06 a Bundle takes in the open issues it is bundled with, once`; `Implementer run > REQ-001-06 / REQ-001-09 labels the Bundle in progress …`, `… opens a PR … that closes every issue`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                                |
| REQ-001-07 | `deriveActions > REQ-001-07 starts nothing for an issue labelled … while its … session is live` (planning, in-progress, reviewing), `… finds a batch Planner session through any of its issues`                                                                                                                     ; `reconcile loop > REQ-001-02 / REQ-001-07 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | pass                                                                                                                |
| REQ-001-08 | `config > REQ-001-08 rejects limits …`, `… allows zero feedback rounds`; `scheduler > REQ-001-08 starts work in priority order …`, `… oldest approval first`, `… never exceeds a Role's Slots or the total …`, `… lower-priority work for a free Role starts …`, `… holds back work for a session that is running …`; `reconcile loop > REQ-001-08 limits apply across repositories …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass                                                                                                                |
| REQ-001-09 | `worktrees > REQ-001-09 …` (3 tests); `deriveActions > REQ-001-09 an approved, unblocked issue …`; `Implementer run > REQ-001-09 …` (3 tests: start, limited context, push and PR); `reconcile loop > REQ-001-09 / REQ-001-14 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass                                                                                                                |
| REQ-001-10 | `GitHub client > REQ-001-10 posts a Review … always with event COMMENT`, `REQ-001-10 / REQ-001-28 reads a PR's head commit, base branch and whether it can be merged`, `… summarises check runs …`; `worktrees > REQ-001-10 review checkouts …`; `deriveActions > REQ-001-10 …` (5 tests, incl. `no checks count as passed only once the grace period … is over`); `Reviewer run > REQ-001-10 …` (2 tests, incl. the `agent:reviewing` label); `reconcile loop > REQ-001-10 / REQ-001-23 …`, `REQ-001-10 a new head without checks is reviewed only after the grace period`                                                                                                                                                                                                                                                                                                                                                                                              | pass                                                                                                                |
| REQ-001-11 | `Reviewer run > REQ-001-11 …` (2 tests: no findings → agent:reviewed; every finding, a single medium one too, kept numbered, → agent:in-progress); `deriveActions > REQ-001-11 …` (2 tests: counted round, agent:failed past the limit, naming the head); `Implementer run > REQ-001-11 …` (3 tests: resume labelled agent:in-progress, fresh session, back to agent:pr-open); `reconcile loop > REQ-001-11 …` (2 tests), `REQ-001-11 / REQ-001-35 / REQ-001-36 a medium finding is fixed in a round, answered on the PR and shown to the re-review`; `Result validation > REQ-002-09 …`                                                                                                                                                                                                                                                                                                                                                                                 | pass                                                                                                                |
| REQ-001-12 | `GitHub client > REQ-001-12 lists PR reviews …`; `deriveActions > REQ-001-12 the Owner's /agent comment or changes-requested review starts an uncounted round, even past the limit`, `REQ-001-10 / REQ-001-12 no Review of a head …`; `reconcile loop > REQ-001-12 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass                                                                                                                |
| REQ-001-13 | `GitHub client > REQ-001-13 failed checks carry their output summary`; `deriveActions > REQ-001-13 …`, `REQ-001-13 / REQ-001-28 giving up past the limit names the head …`; `reconcile loop > REQ-001-13 failing checks start a round with their output, once per head`, `REQ-001-13 past maxFeedbackRounds, failing checks give up once per head …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | pass                                                                                                                |
| REQ-001-28 | `GitHub client > REQ-001-10 / REQ-001-28 reads … whether it can be merged`; `store > REQ-001-28 a store created before the merge-conflict columns existed is migrated`; `worktrees > REQ-001-28 fetches the default branch into a Worktree …`; `deriveActions > REQ-001-28 …` (4 tests: uncounted round once per head, no Review while conflicting or unknown, merge round past the limit, no automatic round on a failed issue), `REQ-001-13 / REQ-001-28 giving up …`; `reconcile loop > REQ-001-28 merge conflicts fetch the default branch, then start an uncounted round, once per head`, `REQ-001-28 a reviewed PR that conflicts after maxFeedbackRounds gets a merge round, then goes back to draft and is reviewed`; manual: one real PR that conflicts after a merge to main                                                                                                                                                                                   | pass (manual run open)                                                                                              |
| REQ-001-14 | `worktrees > REQ-001-14 …`; `store > REQ-001-14 lists Worktrees on record …`; `GitHub client > REQ-001-14 reads whether a PR is open, closed or merged`; `deriveActions > REQ-001-14 …` (4 tests: cleaned up once merged or closed, missing from the list but open gets a Review, … a Feedback round, unfetched PR decides nothing); `Implementer run > REQ-001-14 cleanup … and the PR on record`, `REQ-001-19 cleanup waits …`; `reconcile loop > REQ-001-09 / REQ-001-14 …`, `REQ-001-14 an issue whose PR was closed without merging is … planned anew`, `REQ-001-14 a PR missing from a cached (304) or lagging list …`, `REQ-001-14 when a PR can't be fetched nothing is cleaned up …`                                                                                                                                                                                                                                                                            | pass                                                                                                                |
| REQ-001-15 | `config > REQ-001-15 requires the GitHub App's id …`; `GitHub App auth > REQ-001-15 signs an RS256 app JWT …`, `… mints an installation token per repository …`                                                                                                                                                     ; `main clones > REQ-001-15 never stores the token in the clone`, `… passes the token as a one-off HTTP header`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | partial (config, GitHub auth): pass                                                                                 |
| REQ-001-16 | `issue state from labels > REQ-001-16 no agent label means new; the most advanced agent label wins`; `deriveActions > REQ-001-16 resumes an interrupted session once …`, `… labels the issue agent:failed when …` (3 cases), `REQ-001-16 a session that exited before Claude Code started cannot be resumed`, `… idle … is just marked closed`; `store > REQ-001-16 keeps sessions across a restart`                                                                                                      ; `session runner > REQ-001-16 a session still marked running whose window is gone …`; `reconcile loop > REQ-001-16 resumes a session interrupted by a restart once …`                                                                                                                                                                                                                                                                                         | pass                                                                                                                |
| REQ-001-17 | `scheduler > REQ-001-17 starts nothing while the usage limit pause lasts …`; `store > REQ-001-17 keeps each Account's usage-limit pause …`; `store > REQ-001-17 the single pause of an older store becomes the first Account's`; `hook > REQ-001-17 a turn cut off by the usage limit is not blocked …`; `Accounts > REQ-001-17 new work waits only while every Account is paused …`; `copyTranscript > REQ-001-17 …`; `session runner > Accounts > REQ-001-17 a session resumed on another Account takes its transcript along`; `reconcile loop > REQ-001-17 with one Account, pauses after the usage limit …`; `reconcile loop > REQ-001-17 / REQ-004-01 a usage limit pauses only its Account …`                                                                                                                                                                                                                                                                      | partial (detection unverified against a real limit; resuming on another login unverified): pass                     |
| REQ-001-18 | `claude command line > REQ-001-18 / REQ-001-22 …`; `session runner > REQ-001-18 starts a session in its own tmux window …`; `hook > REQ-001-18 SessionStart records Claude's session id …`; manual: `bun scripts/smoke-runner.ts` (2026-11-10, haiku)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass                                                                                                                |
| REQ-001-19 | `hook > REQ-001-19 …` (3 tests); `session runner > REQ-001-19 …`; `plan revision > REQ-001-19 …`; `Implementer run > REQ-001-19 later turns, including the Owner's, push new commits and update the PR body`, `… cleanup waits while the Owner is chatting …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass                                                                                                                |
| REQ-001-20 | `config > REQ-001-20 rejects maxRunning above maxLiveSessions …`; `scheduler > REQ-001-20 …` (8 tests); `session runner > REQ-001-20 closes an idle session by killing its window`, `… resumes a closed or idle session with --resume …`                                                                            ; `reconcile loop > REQ-001-20 closes sessions idle longer than idleTimeoutMin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | pass                                                                                                                |
| REQ-001-21 | `Result validation > REQ-001-21 …` (4 tests); `hook > REQ-001-21 …` (3 tests); `Planner pass > REQ-001-21 a session that gave up on its Result labels its issues agent:failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | partial (Implementer and Reviewer in T11/T12): pass                                                                 |
| REQ-001-22 | `config > REQ-001-22 …` (3 tests); `prompts > REQ-001-22 each Role has a default prompt`, `… a repository can replace a Role's prompt …`; `claude command line > REQ-001-18 / REQ-001-22 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | pass                                                                                                                |
| REQ-001-23 | `Reviewer run > REQ-001-10 / REQ-001-23 posts one COMMENT review … then closes the session and its checkout`; `reconcile loop > REQ-001-10 / REQ-001-23 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass                                                                                                                |
| REQ-001-24 | `session runner > REQ-001-24 a wake keeps the existing Result file`; `deriveActions > REQ-001-24 …`; `reconcile loop > REQ-001-24 /wake on a PR resumes its closed Implementer session …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass                                                                                                                |
| REQ-001-25 | `permissions > REQ-001-25 …` (2 tests, incl. WebSearch/WebFetch and `git ls-files` but not `git grep` (REQ-002-07) for Planner and Reviewer); `config > REQ-001-25 sandbox network domains default to the common package registries …`; `session runner > REQ-001-25 …` (3 tests: modes, sandbox and network per Role, Planner/Reviewer `denyWrite` of their cwd (#23), kept on resume); manual: smoke runs 2026-11-11 (reviewer write denied; implementer Bash/commit, sandbox was silently off then), 2026-11-12 (`claude -p --permission-mode dontAsk --allowedTools WebSearch …`: search succeeded); manual: `bun scripts/smoke-runner.ts --role reviewer --model haiku` (2026-11-15): `git log -1 --output=<cwd>/…` denied, `git status/log/show/diff/ls-files` worked                                                                                                                                                                                              | partial (sandboxed Bash blocked by Ubuntu AppArmor until docs/setup.md step 1 is applied): pass                     |
| REQ-001-26 | `session runner > REQ-001-26 every Role is denied reading the Coordinator's secrets, with file tools and in shell commands`; live: the secrets were in the effective `denyRead` of issue #1's session; manual: `bun scripts/smoke-runner.ts [--secret <path>]` probes a shell read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | partial (a read in a live session is still to be recorded: auto mode refused the probe from inside a session): pass |
| REQ-001-27 | `reconcile loop > REQ-001-27 a failed sync is retried on the next tick`, `… retried after its session was closed, without failing the issue`, `… after 3 failed syncs in a row the issue is labelled agent:failed with the error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass                                                                                                                |
| REQ-001-29 | `agent note > REQ-001-29 …` (model name and note variants); `hook > REQ-001-29 …` (model from SessionStart, transcript fallback); `store > REQ-001-29 …`; `Assessment comment > REQ-001-29 …`; `Implementer run > REQ-001-09 / REQ-001-29 …`; `Reviewer run > REQ-001-29 …`; `reconcile loop > REQ-001-29 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass                                                                                                                |
| REQ-001-30 | `session runner > REQ-001-30 an Implementer's shell commands may write only to its Worktree and session folder`; live: issue #1's session's effective write allowlist was its Worktree, session folder and temporary folders; a later turn (2026-11-13) saw `touch ../probe-outside` fail with "Read-only file system" while writes to `$TMPDIR` and commits (stored in the Worktree's own `.git`, empty `alternates`) succeeded; manual: `bun scripts/smoke-runner.ts` probes writes inside and outside the repo plus a commit                                                                                                                                                                                                                                                                                                                                                                                                                                          | partial (smoke probes still to be recorded): pass                                                                   |
| REQ-001-31 | `GitHub client > REQ-001-31 …` (4 tests); `Reviewer run > REQ-001-31 …` (2 tests: ready / still draft with any finding); `Implementer run > REQ-001-31 …` (3 tests: new head → draft, nothing new → stays ready, all findings declined without commits → draft at agent:pr-open); `Implementer run > REQ-001-38 …`; `deriveActions > REQ-001-31 after a round that declined the findings …`; `reconcile loop > REQ-001-31 …`, `REQ-001-10 / REQ-001-23 …` (ready), `REQ-001-11 past maxFeedbackRounds …` (draft)                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass                                                                                                                |
| REQ-001-32 | `plan revision > REQ-001-32 a deleted Assessment comment is posted again and edited from then on`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass                                                                                                                |
| REQ-001-33 | `claude command line > REQ-001-33 …` (5 tests: issue, Bundle, batch Planner, truncation, no title); `session runner > REQ-001-18 starts a session …`, `REQ-001-20 / REQ-001-33 resumes …`; `store > REQ-001-33 keeps the session's issue title, also in a database created before it existed`; `Implementer run > REQ-001-06 / REQ-001-09 / REQ-001-33 …`, `REQ-001-11 / REQ-001-33 …`; `Reviewer run > REQ-001-10 / REQ-001-33 …`; `plan revision > REQ-001-03 / REQ-001-33 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pass                                                                                                                |
| REQ-001-34 | `Result validation > REQ-001-34 a Planner entry may list up to 5 Split-off issues …`; `GitHub client > REQ-001-34 creates an issue …`; `store > REQ-001-34 records Split-off issues per parent, also in a database created before they existed`; `Assessment comment > REQ-001-34 lists the Split-off issues under Coordination`; `Split-off issues > REQ-001-34 …` (2 tests: created once with note and back-link, no re-creation on a revision); `deriveActions > REQ-001-01 / REQ-001-34 …`, `REQ-001-04 / REQ-001-34 on a Split-off issue only the Owner's comments count`; `reconcile loop > REQ-001-34 a Split-off issue is planned like an Owner issue, and the Owner's /approve approves it`; manual: one real Planner run that splits an issue                                                                                                                                                                                                                  | pass (manual run open)                                                                                              |
| REQ-001-35 | `Result validation > REQ-001-35 …`; `hook > REQ-001-35 …`; `Implementer run > REQ-001-35 …` (4 tests: answers comment, unanswered finding not synced, no-commit automatic round says why it waits in the same comment, no comment without Review findings), `REQ-001-31 / REQ-001-35 …`; `prompts > REQ-001-35 …`; `store > … migrated`; `reconcile loop > REQ-001-11 / REQ-001-35 / REQ-001-36 …`, `REQ-001-11 past maxFeedbackRounds …` (findings cleared)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass (manual run on a real PR: open)                                                                                |
| REQ-001-36 | `Reviewer run > REQ-001-36 …` (2 tests: history in the context, none on a first Review); `Implementer run > REQ-001-36 answers of later rounds are added to the history`; `reconcile loop > REQ-001-11 / REQ-001-35 / REQ-001-36 …`; `prompts > REQ-002-09 …` (declined findings)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass (manual run on a real PR: open)                                                                                |
| REQ-001-37 | `deriveActions > REQ-001-37 the Owner's round on a conflicting PR fetches the default branch and asks for the merge, also once it failed`; `Implementer run > REQ-001-11 a Feedback round resumes …` (clears `agent:failed`); `reconcile loop > REQ-001-37 the Owner's /agent on a failed, conflicting PR fetches the base, runs an uncounted round and clears agent:failed`; manual: `/agent fix the conflicts` on a real conflicting PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass (manual run open)                                                                                              |
| REQ-001-38 | `deriveActions > REQ-001-38 an automatic round names its causes …`; `Implementer run > REQ-001-38 …` (2 tests: checks and conflicts stall comment once, none after a new head), `REQ-001-31 / REQ-001-35 …` (stall in the answers comment), `REQ-001-35 a round without Review findings …` (none for a round without causes); `store > REQ-001-28 … migrated`; `reconcile loop > REQ-001-38 a conflict round that ends without a new commit tells the Owner on the PR, once`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass                                                                                                                |
| REQ-001-39 | `Reviewer run > REQ-001-11 / REQ-001-39 … goes straight to agent:in-progress`; `deriveActions > REQ-001-39 …` (2 tests: round instead of agent:failed, agent:failed past the limit), `REQ-001-07 / REQ-001-39 … without Review findings on record … still fails`; `reconcile loop > REQ-001-39 … without agent:pr-open, also across a restart`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                                |
| REQ-001-40 | `replies to the Owner's comments > REQ-001-40 …` (5 tests: Reply with links, unchanged Assessment and several comments, no Reply on an Owner-chat turn, fallback line, posted once on a retry with REQ-001-27), `REQ-001-41 / REQ-001-40 …`; `Result validation > REQ-001-40 …`; `store > REQ-001-40 keeps the comments a reply is pending for, also in a database created before they existed`; `reconcile loop > REQ-001-03 an Owner comment on a proposal revises the plan …`; manual: one real comment round on a test issue                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass (manual run open)                                                                                              |
| REQ-001-41 | `replies to the Owner's comments > REQ-001-41 an edited issue is planned from scratch …`, `REQ-001-41 / REQ-001-40 comments from the same poll …`; `reconcile loop > REQ-001-41 an edited issue description is planned from scratch, with the open issues as context`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass                                                                                                                |
| REQ-001-42 | `GitHub client > REQ-001-42 lists open PRs with head branch, head repository and body, polling with the ETag`; `deriveActions > REQ-001-42 …` (4 tests: no Planner pass for an issue a PR is named after, nor one it closes, no Implementer or Bundle membership for an approved issue, forks and other branch names ignored); `reconcile loop > REQ-001-42 / REQ-001-43 a new issue with an orphaned agent PR is not planned …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass                                                                                                                |
| REQ-001-43 | `worktrees > REQ-001-43 …` (2 tests: built from the remote branch, tracking it, push stays a fast-forward; no existing folder reused, maxWorktrees respected); `deriveActions > REQ-001-43 …` (5 tests: re-attach for open issues in scope, no `agent:failed` for a stale in-flight label, not with a Worktree on record, not with an open or unsynced session, only reported when its issues are closed); `Implementer run > REQ-001-43 re-attaching records the PR and Worktree …`; `reconcile loop > REQ-001-42 / REQ-001-43 … re-attached and reviewed`, `REQ-001-43 an approved issue's orphaned PR is re-attached …; Feedback rounds resume`, `… stale agent:failed or agent:in-progress labels ends up only agent:pr-open, and automatic rounds resume`, `… GitHub reports closed, or with another branch, is not re-attached`, `… while maxWorktrees is reached …`, `… issues are all closed is logged once`; manual: the PR #34 orphan (issue #33) after deploy | pass (manual run open)                                                                                              |
| REQ-001-44 | `session runner > REQ-001-44 a session that cannot be launched is recorded as closed …`, `… cannot be relaunched on resume …`; `reconcile loop > REQ-001-44 a session that cannot be launched fails its issues once, with the error > …` (7 tests: Planner pass, revision in a new session, revision resuming its session, revision from scratch after an edit, all three with the feedback kept, Implementer run, Feedback round, Review)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass                                                                                                                |
| REQ-001-45 | `session runner > REQ-001-45 a long prompt reaches claude in full, as one argument, without shell interpretation` (64 KB prompt with quotes, `$()`, backticks, run through a real `sh`); not run in real tmux (the sandbox blocks tmux sockets)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pass                                                                                                                |
| REQ-001-46 | Deprecated by REQ-001-52; its tests now cover REQ-001-52                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                   |
| REQ-001-47 | `Linked history > REQ-001-47 …` (8 tests: link picking incl. other repositories and dedup, rendering incl. the agent note left out of snippets, caps with failed and not fetched items, a busy PR's Reviews and latest comments surviving the cap, Planner pass fetched once and at most 5 per issue without the issue itself, failed fetch, no links means the old prompt, revision fresh / resumed / from scratch); `GitHub client > REQ-001-47 reads a linked PR's history …`, `… a linked issue's history without fetching a PR`; manual: plan a test issue linking a merged PR and read the prompt in the session folder                                                                                                                                                                                                                                                                                                                                            | pass (manual run open)                                                                                              |
| REQ-001-48 | `Result validation > REQ-001-48 an Implementer Result may list Screenshots with a path and a caption`; `worktrees > REQ-001-48 every Worktree's git ignores .coordinator/ locally, also a re-used or re-attached one`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass                                                                                                                |
| REQ-001-49 | `worktrees > REQ-001-49 publishes Screenshots on the orphan branch agent-screenshots under pr-<n>/<head>/, one commit per publish` (temp git repo: orphan, parent chain, earlier files kept, default branch, PR branch and Worktree untouched); `Screenshots > REQ-001-49 / REQ-001-50 the first turn opens the PR, publishes …`; manual: the first real PR with a UI change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass (manual run open)                                                                                              |
| REQ-001-50 | `Screenshots > REQ-001-49 / REQ-001-50 …`, `REQ-001-50 a later turn without screenshots keeps the last section …`, `REQ-001-50 a failed publish still opens the PR …`, `REQ-001-50 captions can't break the image markup`; manual: images render in a private repository's PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass (manual run open)                                                                                              |
| REQ-001-51 | `Screenshots > REQ-001-51 files outside the folder, through a symlink, not regular, …`, `REQ-001-51 wrong first bytes, a file over 2 MB and a missing file …`, `REQ-001-51 when every Screenshot is skipped nothing is published …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | pass                                                                                                                |
| REQ-001-52 | `GitHub client > REQ-001-52 adds the given users as assignees of an issue or PR`; `Reviewer run > REQ-001-52 …` (3 tests: clean Review assigns the Owner after leaving draft, any finding assigns nobody, refused assignment logged while the PR still goes ready and nothing fails); `reconcile loop > REQ-001-10 / REQ-001-23 / REQ-001-52 …` (no review request); manual: the next clean Review shows the Owner as assignee                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass (manual run open)                                                                                              |
| REQ-001-53 | `headless browser check (doctor) > REQ-001-53 …` (6 tests: lookup order, `--no-sandbox` arguments, PNG written, non-zero exit with its error, exit 0 without a PNG, nothing left behind); manual: `bun scripts/smoke-runner.ts --screenshot` on the host (a real sandboxed Implementer session serves a fixture page and shoots it; not runnable from an Implementer's sandbox, which blocks tmux sockets)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass (doctor); open (smoke run by the Owner)                                                                        |
| REQ-001-54 | `REQ-001-54 an agent PR shows its state > …` in `Implementer run` tests (6 tests: PR opened, Feedback round and its sync, new head outside a round from agent:reviewed, new head on a failed PR, giving up on the Result in a round, re-attach) and `Reviewer run` tests (4 tests: Review start, findings, no findings, giving up on the Result); `reconcile loop > REQ-001-54 through Review, Feedback round, re-review and failure …`, `REQ-001-37 the Owner's /agent on a failed, conflicting PR …` (PR at agent:in-progress); `GitHub client > REQ-001-54 removing a label says whether the issue or PR had it`; `README Labels section > REQ-001-54 …`; manual: open PRs take their label at their next transition after deploy                                                                                                                                                                                                                                     | pass (manual run open)                                                                                              |
