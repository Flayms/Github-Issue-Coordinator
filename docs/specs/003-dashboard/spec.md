# 003 – Dashboard

**Status:** Implemented

## Goal

The Owner wants to see at a glance, also on a phone, what the Coordinator is doing: which agents are running, where each issue stands, which agent PRs are ready to merge, what runs next and with which settings. Today that means opening GitHub, the Claude app and an SSH session. The dashboard is a read-only web page served by the Coordinator itself. It changes nothing, so approving, giving feedback and merging stay on GitHub, where only the Owner's actions count (REQ-001-01). Because the server runs agents that can push code, the page is private by default.

## Requirements

### REQ-003-01 Running agents

- **Given** open agent sessions at the end of a tick
- **When** the Owner opens the dashboard
- **Then** each session shows its Role, repository, issues (with titles), state (running or idle), start time, how long it has been idle, and its Remote Control name, so the Owner can find it in the Claude app
- **And** a session whose tmux window is gone is marked as such

### REQ-003-02 Pipeline

- **Given** the open in-scope issues of all configured repositories (REQ-001-01)
- **When** the dashboard is shown
- **Then** each issue appears in the column of its phase, taken from its `agent:*` label (`new` for none), in the order of the workflow; empty columns are left out
- **And** each issue links to GitHub and shows its agent PR (linked), its Feedback rounds out of `maxFeedbackRounds`, the PR's checks, and whether GitHub can merge it

### REQ-003-03 Ready to merge

- **Given** an open agent PR whose issues are `agent:reviewed`, whose checks passed (or that has none) and that GitHub reports as mergeable
- **When** the dashboard is shown
- **Then** it is listed first, in a "Ready to merge" section, linked to the PR

### REQ-003-04 Planned order

- **Given** the work the last tick queued
- **When** the dashboard is shown
- **Then** the queue is shown in the scheduler's order (REQ-001-08)
- **And** each item says whether it started in that tick or why it waits: the usage-limit pause (until when), `maxRunning`, the Role's Slots, its session being busy, `maxLiveSessions`, or `maxWorktrees`
- **And** approved issues that wait for open blockers are listed with the issues they are blocked by (REQ-001-05)

### REQ-003-05 Settings (read-only)

- **Given** the Coordinator's config
- **When** the dashboard is shown
- **Then** the effective settings are shown: the poll interval, the limits, the model and effort per Role and repository, and each repository's setup command and sandbox domains
- **And** no secrets are shown: no private key (content or path) and no dashboard token (content or path)

### REQ-003-06 Freshness

- **Given** the dashboard is open
- **Then** the page shows when the last tick finished, or that there was none yet
- **And** it reloads itself every poll interval
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
- **And** the page loads no scripts and no resources from other origins, and cannot be embedded in another site

### REQ-003-10 Agents can't read the token

- **Given** a configured dashboard token file
- **When** an agent session runs
- **Then** the session is denied reading the token's folder, like the Coordinator's other secrets (REQ-001-26)

## Out of scope

- Write actions (approve, retry, merge, edit settings). Approval stays on GitHub, where the Owner's identity is checked.
- Exposing the dashboard on the public internet with its own login. Remote access goes through Tailscale or an SSH tunnel (`docs/setup.md`).
- HTTPS in the Coordinator itself; `tailscale serve` provides it.
- History of past ticks, logs, transcripts.

## Assumptions

- One Owner, one browser; no user accounts.
- A view of the last tick (every `pollIntervalSec`) is fresh enough.
- The Owner reaches the server over Tailscale or an SSH tunnel, so the page needs no login of its own beyond the token.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                            | Result                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| REQ-003-01 | `dashboard view > REQ-003-01 …` (2 tests: fields incl. Remote Control name, window gone); `store > REQ-003-01 keeps when a session started …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 publishes a snapshot …`                                                                   | pass                            |
| REQ-003-02 | `dashboard view > REQ-003-02 …` (2 tests: columns in workflow order, PR with rounds/checks/mergeability); `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 …`                                                                                                                             | pass                            |
| REQ-003-03 | `dashboard view > REQ-003-03 …` (2 tests: the filter, a Bundle only when all its issues are reviewed)                                                                                                                                                                                           | pass                            |
| REQ-003-04 | `scheduler > REQ-003-04 …` (2 tests: order and reasons, the pause); `dashboard view > REQ-003-04 …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 …`, `REQ-003-04 an implement job without room …`                                                                                    | pass                            |
| REQ-003-05 | `dashboard view > REQ-003-05 shows the effective settings per Role and repository, without secrets`                                                                                                                                                                                             | pass                            |
| REQ-003-06 | `dashboard view > REQ-003-06 …` (2 tests: last tick and reload, no tick yet); `reconcile loop > REQ-003-06 a repository whose poll failed …`                                                                                                                                                    | pass                            |
| REQ-003-07 | `config > REQ-003-07 …` (2 tests: on by default on loopback and `false` turns it off, token required off loopback); `dashboard server > REQ-003-07 …` (7 tests: no server with `false`, 127.0.0.1:8080 without a block, 127.0.0.1, 401, token via header/cookie, GET only, unusable token file) | pass                            |
| REQ-003-08 | `dashboard server > REQ-003-08 …` (3 tests: render exception, port in use, default port in use)                                                                                                                                                                                                 | pass                            |
| REQ-003-09 | `dashboard view > REQ-003-09 text from GitHub and agents is escaped`; `dashboard server > REQ-003-09 the page loads nothing from elsewhere …`                                                                                                                                                   | pass                            |
| REQ-003-10 | `config > REQ-003-10 / REQ-001-26 agents are denied … the dashboard token's folder`                                                                                                                                                                                                             | pass                            |
| Acceptance | manual: open it on a phone over Tailscale; without a `dashboard` block, an SSH tunnel to `127.0.0.1:8080` loads the page                                                                                                                                                                        | open (needs the Owner's server) |
