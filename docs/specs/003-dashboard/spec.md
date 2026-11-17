# 003 – Dashboard

**Status:** Implemented

## Goal

The Owner wants to see at a glance, also on a phone, what the Coordinator is doing: which agents are running, what it did recently, where each issue stands, which agent PRs are ready to merge, what runs next and with which settings. Today that means opening GitHub, the Claude app and an SSH session. The dashboard is a read-only web page served by the Coordinator itself. It changes nothing, so approving, giving feedback and merging stay on GitHub, where only the Owner's actions count (REQ-001-01). Because the server runs agents that can push code, the page is private by default.

## Requirements

### REQ-003-01 Running agents

- **Given** open agent sessions at the end of a tick
- **When** the Owner opens the dashboard
- **Then** each session shows its Role, repository, issues (with titles), state (running or idle), model, start time and its Remote Control name, so the Owner can find it in the Claude app
- **And** a running session shows an animated "running" bar; an idle session shows how long it has been idle out of `idleTimeoutMin` (e.g. `idle 4 min of 30 min`), as text and as a bar
- **And** a session whose tmux window is gone is marked as such
- **And** a "Copy name" button copies the Remote Control name; it needs JavaScript, so the name is always shown as text too

### REQ-003-02 Pipeline

- **Given** the open in-scope issues of all configured repositories (REQ-001-01)
- **When** the dashboard is shown
- **Then** the issues appear in seven columns, each with its count, by the phase of their `agent:*` label (`new` for none): Intake (new, planning), Your move (proposed, needs-refinement, wontfix-proposed), Approved (approved, blocked), Building (in-progress), In review (pr-open, reviewing), Reviewed, Failed
- **And** each issue links to GitHub and says in words what is happening or what the Owner must do
- **And** each issue shows its agent PR (linked), its Feedback rounds out of `maxFeedbackRounds`, the PR's checks, and whether GitHub can merge it

### REQ-003-03 Ready to merge

- **Given** an open agent PR whose issues are `agent:reviewed`, whose checks passed (or that has none) and that GitHub reports as mergeable
- **When** the dashboard is shown
- **Then** it is listed first, next to the Summary (REQ-003-11), with its title, repository, PR number and checks, linked to the PR

### REQ-003-04 Planned order

- **Given** the work the last tick queued
- **When** the dashboard is shown
- **Then** the queue is shown as a list of steps in the scheduler's order (REQ-001-08), the first one marked "next"
- **And** each item says whether it started in that tick or why it waits: the usage-limit pause (until when), `maxRunning`, the Role's Slots, its session being busy, `maxLiveSessions`, or `maxWorktrees`
- **And** approved issues that wait for open blockers are listed after it, marked as blocked, with the issues they are blocked by (REQ-001-05)

### REQ-003-05 Config page (read-only)

- **Given** the Coordinator's config
- **When** the Owner opens the Config page (`/config`, a plain link in the page header)
- **Then** it shows a headline with the poll interval and the number of repositories
- **And** how the page is reached, taken from the config: host and port, whether a token is required, that it answers only GET and makes no GitHub calls
- **And** the limits, the model and effort per Role with each repository's overrides, and each repository with its setup command and its counts of open issues, agent PRs and Worktrees from the last tick
- **And** no secrets are shown: no private key (content or path) and no dashboard token (content or path)

### REQ-003-06 Freshness

- **Given** the dashboard is open
- **Then** the page shows when the last tick finished, or that there was none yet
- **And** it reloads itself every poll interval, with a countdown to the next reload; without JavaScript it still reloads (meta refresh)
- **And** a repository whose poll failed in the last tick shows the error

### REQ-003-07 Access

- **Given** no `dashboard` block in the config
- **When** the Coordinator starts
- **Then** the dashboard listens on `127.0.0.1:8080` without a token
- **Given** `dashboard: false` in the config
- **When** the Coordinator starts
- **Then** no server is started and nothing is logged as a failure
- **Given** a `dashboard` block without a host
- **Then** the server listens on `127.0.0.1` only
- **Given** a host other than a loopback address
- **When** no token is configured
- **Then** the Coordinator refuses to start
- **Given** a configured token
- **When** a request does not carry the token
- **Then** it gets 401 and no dashboard content
- **And** the server answers only GET requests (others get 405), and serving a request changes nothing in the store, on GitHub or in the sessions

### REQ-003-08 Isolation

- **Given** a running dashboard
- **When** serving a request fails (a bad request, an exception while rendering) or the server cannot be started
- **Then** the request gets an error response and the reconcile loop keeps running
- **And** the dashboard makes no GitHub requests of its own; it shows the state of the last tick

### REQ-003-09 Untrusted text

- **Given** issue titles, session names and other text that came from GitHub or agents
- **When** the dashboard shows it
- **Then** it is shown as text: it cannot add markup or scripts to the page
- **And** the page loads scripts, styles and fonts only from its own origin, from a fixed list of files, and nothing from other origins (no CDN, no web fonts service); it has no inline scripts or styles and cannot be embedded in another site
- **And** without JavaScript all content can still be read and reached

### REQ-003-10 Agents can't read the token

> **Deprecated** by REQ-005-01 (spec 005): agents may read anything on the VM, the dashboard token included; the dashboard is read-only.

- **Given** a configured dashboard token file
- **When** an agent session runs
- **Then** the session is denied reading the token's folder, like the Coordinator's other secrets (REQ-001-26)

### REQ-003-11 Summary

- **Given** the last tick
- **When** the Overview is shown
- **Then** a headline says how many agent PRs are ready to merge (REQ-003-03), and those PRs are listed next to it
- **And** below it are the counts of: working (running sessions), need you (issues `proposed`, `needs-refinement`, `wontfix-proposed` or `reviewed`), stuck (`failed` or `blocked`) and queued (queued work that waits)

### REQ-003-12 Capacity

- **Given** the limits and the last tick
- **When** the Overview is shown
- **Then** there is one meter each for running sessions (`maxRunning`), live sessions (`maxLiveSessions`), the Slots of each Role (running sessions of that Role out of its `max…` limit) and Worktrees (`maxWorktrees`), each showing used out of the limit

### REQ-003-13 Repository filter

- **Given** more than one configured repository
- **When** the Owner picks one (`?repo=`, a plain link)
- **Then** the Pipeline shows only that repository's issues, and the filter shows which one is picked
- **And** an unknown repository shows all of them

### REQ-003-14 Motion

- **Given** the dashboard is open in a browser with WebGL
- **Then** the animated background is visible behind the content, also when the browser asks for reduced motion (`prefers-reduced-motion`)
- **And** other animations and transitions are off for reduced motion
- **And** while the tab is hidden the animated background pauses
- **And** without WebGL the static gradient stays

### REQ-003-15 Event log

- **Given** the Coordinator posts a Role's Result (an Assessment and its verdict, a Review and its outcome), opens an agent PR, starts a Feedback round, sees an approval, blocks or unblocks an issue, or fails an issue
- **When** that action succeeded on GitHub
- **Then** it records an Event in the store: time, repository, issue or PR numbers, kind and a short sentence (for a failure, the reason)
- **And** only the newest 200 Events are kept, also across a restart
- **And** if recording an Event fails, the failure is only logged; the tick and the GitHub action are unaffected

### REQ-003-16 Recent

- **Given** recorded Events
- **When** the dashboard is shown
- **Then** the newest 15 appear newest first in a "Recent" column next to "Working now"
- **And** each one shows an icon and a tone by kind (success, neutral, attention or failure), its time, and links to its issue or PR
- **And** the `?repo=` filter (REQ-003-13) narrows it too
- **And** with no Events yet it says so
- **And** titles, failure reasons and other text from GitHub or agents are shown as text only (REQ-003-09)

### REQ-003-19 Component build

- **Given** the dashboard sources: React components and a Tailwind stylesheet
- **When** the Coordinator starts (`bun install && bun start`, no build step of the Owner's own)
- **Then** the pages are rendered on the server from the React components, and the stylesheet is built from its Tailwind source and served from the fixed list of files (REQ-003-09)
- **And** every class the pages use has a rule in that stylesheet

## Out of scope

- Write actions (approve, retry, merge, edit settings). Approval stays on GitHub, where the Owner's identity is checked.
- Exposing the dashboard on the public internet with its own login. Remote access goes through Tailscale or an SSH tunnel (`docs/setup.md`).
- HTTPS in the Coordinator itself; `tailscale serve` provides it.
- Full logs, tick history and transcripts. Recent Events are in scope (REQ-003-15, REQ-003-16); a "PR merged" Event is not, since the Coordinator does not act on merges.
- PR line counts and "time since review": the Tick snapshot doesn't carry them.
- A light theme: the design is dark only.

## Assumptions

- One Owner, one browser; no user accounts.
- The page is server-rendered and has no client-side data fetching: it reloads every poll interval anyway and must work without JavaScript (#72).
- A view of the last tick (every `pollIntervalSec`) is fresh enough.
- 200 kept and 15 shown Events are enough to see what happened since the Owner last looked; no setting for either.
- The Owner reaches the server over Tailscale or an SSH tunnel, so the page needs no login of its own beyond the token.
- The fonts (Plus Jakarta Sans, Inter, JetBrains Mono) are served from the Coordinator under the SIL Open Font License; other scripts than Latin fall back to system fonts.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Result                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| REQ-003-01 | `dashboard view > REQ-003-01 …` (4 tests: fields incl. model and Remote Control name, idle time out of `idleTimeoutMin` as text and bar, reported vs configured model, window gone); `dashboard html > REQ-003-01 each session shows its model and its Remote Control name, with a copy button only for scripts`; `store > REQ-003-01 keeps when a session started …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 publishes a snapshot …`                                                                                           | pass                                                                                                               |
| REQ-003-02 | `dashboard view > REQ-003-02 …` (3 tests: seven columns in workflow order, status in words, PR with rounds/checks/mergeability); `dashboard html > REQ-003-02 the Pipeline shows seven columns …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 …`                                                                                                                                                                                                                                                                                    | pass                                                                                                               |
| REQ-003-03 | `dashboard view > REQ-003-03 …` (2 tests: the filter, a Bundle only when all its issues are reviewed); `dashboard html > REQ-003-11 lists the ready PRs next to the headline …`                                                                                                                                                                                                                                                                                                                                                                 | pass                                                                                                               |
| REQ-003-04 | `scheduler > REQ-003-04 …` (2 tests: order and reasons, the pause); `dashboard view > REQ-003-04 …`; `dashboard html > REQ-003-04 the first step is marked next …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 …`, `REQ-003-04 an implement job without room …`                                                                                                                                                                                                                                                                     | pass                                                                                                               |
| REQ-003-05 | `dashboard view > REQ-003-05 …` (2 tests: settings per Role and repository with overrides and access, without secrets; counts per repository); `dashboard html > REQ-003-05 …` (2 tests: the Config page, header links); `dashboard server > REQ-003-05 serves the Config page at /config`                                                                                                                                                                                                                                                      | pass                                                                                                               |
| REQ-003-06 | `dashboard view > REQ-003-06 …` (2 tests: last tick and reload, no tick yet); `dashboard html > REQ-003-06 a countdown to the next reload, and a meta refresh …`; `reconcile loop > REQ-003-06 a repository whose poll failed …`                                                                                                                                                                                                                                                                                                                | pass                                                                                                               |
| REQ-003-07 | `config > REQ-003-07 …` (2 tests: on by default on loopback and `false` turns it off, token required off loopback); `dashboard server > REQ-003-07 …` (7 tests: no server with `false`, 127.0.0.1:8080 without a block, 127.0.0.1, 401, token via header/cookie, GET only, unusable token file)                                                                                                                                                                                                                                                 | pass                                                                                                               |
| REQ-003-08 | `dashboard server > REQ-003-08 …` (3 tests: render exception, port in use, default port in use)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | pass                                                                                                               |
| REQ-003-09 | `dashboard view > REQ-003-09 text from GitHub and agents is escaped`; `dashboard html > REQ-003-09 both pages load only same-origin assets …`; `dashboard server > REQ-003-09 …` (2 tests: assets from a fixed list behind the token, the CSP)                                                                                                                                                                                                                                                                                                  | pass                                                                                                               |
| REQ-003-10 | Deprecated by spec 005; its tests were removed with the behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                  |
| REQ-003-11 | `dashboard view > REQ-003-11 sums up …`; `dashboard html > REQ-003-11 lists the ready PRs …`, `… the Overview shows its sections in order`                                                                                                                                                                                                                                                                                                                                                                                                      | pass                                                                                                               |
| REQ-003-12 | `dashboard view > REQ-003-12 shows used out of the limit …`; `dashboard html > REQ-003-12 shows each meter as used out of the limit`                                                                                                                                                                                                                                                                                                                                                                                                            | pass                                                                                                               |
| REQ-003-13 | `dashboard view > REQ-003-13 a picked repository narrows the Pipeline …`; `dashboard html > REQ-003-13 the repository filter is a set of plain links …`; `dashboard server > REQ-003-13 ?repo= narrows the Pipeline`                                                                                                                                                                                                                                                                                                                            | pass                                                                                                               |
| REQ-003-14 | `dashboard html > REQ-003-14 the animated background shows, also for reduced motion …` (checks the stylesheet and script; the behaviour in a browser is manual)                                                                                                                                                                                                                                                                                                                                                                                 | pass (static); browser: open                                                                                       |
| REQ-003-15 | `store > REQ-003-15 …` (2 tests: newest first across a restart, cap at 200); `reconcile loop > REQ-003-15 records one Event per action …` (11 tests: Assessment, approval incl. blocked and unblock, block, PR opened and none on a failed `createPull`, Review with and without findings, Feedback round counted or not, failure with reason, a failing GitHub call records nothing, a store error is only logged); `Planner pass > REQ-003-15 …`, `Implementer run > REQ-003-15 …`, `Reviewer run > REQ-003-15 …` (failures inside the syncs) | pass                                                                                                               |
| REQ-003-16 | `dashboard view > REQ-003-16 …` (5 tests: order, limit, tone, time and links; tone per kind; repo filter; empty state; escaping); `dashboard html > REQ-003-16 Recent sits next to Working now …`, `… the Overview shows its sections in order`; `reconcile loop > REQ-003-16 the snapshot carries the recorded Events …`                                                                                                                                                                                                                       | pass                                                                                                               |
| REQ-003-19 | `dashboard html > REQ-003-19 the stylesheet is built from its Tailwind source and has a rule for every class the pages use`; every other `dashboard html` / `dashboard view` / `dashboard server` test renders the React components                                                                                                                                                                                                                                                                                                             | pass                                                                                                               |
| Acceptance | #72: desktop, phone and Config screenshots from fixture data before and after the React migration look the same; manual: open it on a phone over Tailscale and on desktop, compare with the mockup in #41, screenshots on the PR; without a `dashboard` block, an SSH tunnel to `127.0.0.1:8080` loads the page                                                                                                                                                                                                                                 | #87: desktop and phone screenshots from fixture data match the mockup; on a real phone and the hover effects: open |
