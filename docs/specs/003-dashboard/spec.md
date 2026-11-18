# 003 – Dashboard

**Status:** Implemented

## Goal

The Owner wants to see at a glance, also on a phone, what the Coordinator is doing: which agents are running, what it did recently, where each issue stands, which agent PRs are ready to merge, what runs next and with which settings. Today that means opening GitHub, the Claude app and an SSH session. The dashboard is a read-only web page served by the Coordinator itself. It changes nothing, so approving, giving feedback and merging stay on GitHub, where only the Owner's actions count (REQ-001-01). Because the server runs agents that can push code, the page is private by default: only the Owner gets in, by signing in with GitHub (#115).

## Requirements

### REQ-003-01 Agent sessions

- **Given** open agent sessions at the end of a tick
- **When** the Owner opens the dashboard
- **Then** they are listed under "Now" in Activity (REQ-003-20), running sessions first, then idle ones, then those whose window is gone; no heading calls an idle session working (#74)
- **And** each session shows its Role, repository, issues (with titles), state (running or idle), model, start time and its Remote Control name, so the Owner can find it in the Claude app
- **And** a running session shows an animated "running" bar; an idle session says when it closes (e.g. `idle · closes in 26 min`, the time left until `idleTimeoutMin`), and shows how long it has been idle out of `idleTimeoutMin` as a bar, with the figures (e.g. `idle 4 min of 30 min`) as its tooltip
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
- **Then** the queue is shown under "Next" in Activity (REQ-003-20) as a list of steps in the scheduler's order (REQ-001-08), the first one marked "next"
- **And** each item says whether it started in that tick or why it waits: the usage-limit pause (until when), `maxRunning`, the Role's Slots, its session being busy, `maxLiveSessions`, or `maxWorktrees`
- **And** approved issues that wait for open blockers are listed after it, marked as blocked, with the issues they are blocked by (REQ-001-05)

### REQ-003-05 Config page (read-only)

- **Given** the Coordinator's config
- **When** the Owner opens the Config page (`/config`, a plain link in the page header)
- **Then** it shows a headline with the poll interval and the number of repositories
- **And** how the page is reached, taken from the config: host and port, whether the GitHub sign-in is on, off or not set up (REQ-003-27), whether a token is required, that it answers only GET (besides Sign out) and makes no GitHub calls besides the sign-in's
- **And** the limits, the model and effort per Role with each repository's overrides, and each repository with its setup command and its counts of open issues, agent PRs and Worktrees from the last tick
- **And** no secrets are shown: no private key (content or path), no dashboard token (content or path) and no GitHub client secret (content or path)

### REQ-003-06 Freshness

- **Given** the dashboard is open
- **Then** the page shows when the last tick finished, or that there was none yet
- **And** it reloads itself every poll interval, with a countdown to the next reload; without JavaScript it still reloads (meta refresh)
- **And** a repository whose poll failed in the last tick shows the error

### REQ-003-07 Access

- **Given** no `dashboard` block in the config
- **When** the Coordinator starts
- **Then** the dashboard listens on `127.0.0.1:8080` without a token, with the GitHub sign-in on (REQ-003-27)
- **Given** `dashboard: false` in the config
- **When** the Coordinator starts
- **Then** no server is started and nothing is logged as a failure
- **Given** a `dashboard` block without a host
- **Then** the server listens on `127.0.0.1` only
- **Given** a host other than a loopback address
- **When** no token is configured and the GitHub sign-in is off (`githubLogin: false`)
- **Then** the Coordinator refuses to start (REQ-003-29)
- **Given** a configured token
- **When** a request does not carry the token
- **Then** it gets 401 and no dashboard content
- **And** the server answers only GET requests (others get 405) and `POST /auth/logout` (REQ-003-29), and serving a request changes nothing in the store, on GitHub or in the sessions

### REQ-003-08 Isolation

- **Given** a running dashboard
- **When** serving a request fails (a bad request, an exception while rendering) or the server cannot be started
- **Then** the request gets an error response and the reconcile loop keeps running
- **And** the dashboard makes no GitHub requests of its own besides the GitHub sign-in's: the code exchange and `GET /user` (REQ-003-28), after which the user's access token is dropped; it shows the state of the last tick

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
- **Then** the newest 15 appear newest first under "Recent" in Activity (REQ-003-20), before "Now"
- **And** the first 5 show and the other 10 sit behind an expander, at every width (REQ-003-23)
- **And** each one shows an icon and a tone by kind (success, neutral, attention or failure, as in REQ-003-17), its time, and links to its issue or PR
- **And** the `?repo=` filter (REQ-003-13) narrows it too
- **And** with no Events yet it says so
- **And** titles, failure reasons and other text from GitHub or agents are shown as text only (REQ-003-09)

### REQ-003-17 Colour by meaning

- **Given** the Overview shows items in each state
- **When** an item is waiting for the Owner, has failed, or is only waiting or blocked
- **Then** only the Owner's move uses the attention tone, only failures (a failed issue or Event, failing checks, a gone session window, a failed poll) use red, and blocked or waiting items use a neutral tone
- **And** no item is shown in the attention tone in one place and red in another
- **And** a status's tone marks its dot or icon, while its text stays neutral

### REQ-003-19 Component build

- **Given** the dashboard sources: React components and a Tailwind stylesheet
- **When** the Coordinator starts (`bun install && bun start`, no build step of the Owner's own)
- **Then** the pages are rendered on the server from the React components, and the stylesheet is built from its Tailwind source and served from the fixed list of files (REQ-003-09)
- **And** every class the pages use has a rule in that stylesheet

### REQ-003-20 Activity

- **Given** open sessions, queued work and recorded Events
- **When** the Owner opens the Overview
- **Then** one "Activity" section shows Recent, Now and Next as three parts of one timeline, each headed with its part of time (done, now, next), under one header with the counts (running, idle, queued; the same as the Summary's _working_ and _queued_ counts)
- **And** on a wide screen they sit side by side in time order, Recent, Now, Next, joined by a line; on a phone they are stacked as Now, Next, Recent
- **And** Recent and Next share one row style (an icon, a line of text, a muted line under it), and Next is a vertical list, so the page has no horizontal scroll at 360px
- **And** the frosted band below Activity holds only the Pipeline and the footer

### REQ-003-21 README screenshots

- **Given** a fixed mock Tick snapshot (made-up repositories, issues, PRs, sessions and Events; nothing from this repository's issues), a mock config and a fixed clock
- **When** `bun run screenshots` runs on a host with Chrome or Chromium
- **Then** it renders the Overview at desktop and phone width and the Config page at desktop width into `docs/images/`
- **And** the README shows them next to its description of the dashboard

### REQ-003-22 Screenshots stay current

- **Given** the committed screenshots record a fingerprint of what they were made from: both pages rendered from the mock data, plus every dashboard asset (stylesheet, script, fonts)
- **When** `bun test` runs after a change to the pages' markup or the assets
- **Then** a test fails and names `bun run screenshots` as the fix, and regenerating the screenshots makes it pass
- **And** `bun test` needs no browser

### REQ-003-23 Activity parts stay short

- **Given** Recent, Now or Next holds more than 5 items
- **When** the Overview is shown, at any width
- **Then** the first 5 show in their usual order, the 5th fading out downwards, with a "Show N more" text link under them; it needs no JavaScript and doesn't look like a menu button (no disclosure marker)
- **And** following it shows the rest in place, in the same order and row style, the 5th no longer faded, with a "Show less" link under them that closes it again
- **And** a part with 5 or fewer items has no expander
- **And** the counts in the Activity header stay the totals, not the visible items

### REQ-003-24 Liquid glass meters

- **Given** the Overview shows Capacity (REQ-003-12)
- **When** a meter has used Slots
- **Then** its filled part is a liquid with rounded ends inside a glass tube (frosted, a lit rim and a static reflection), 18 px tall, its width used out of the limit: empty at 0, the whole tube when full
- **And** up to 12 Slots, Slot marks are etched into the glass as faint lines, above the liquid and a little whiter where they cross it, so they stay visible on it; above 12 there are none
- **And** with WebGL the liquid moves like a liquid: a rounded front that wobbles slightly, slow broad swirls, caustics and light, and a few bubbles. Each meter moves differently (its own phase, speed and pattern) and nothing repeats in under 10 s
- **And** it is drawn only while the tab is shown and Capacity is in view, with one WebGL context for all meters (#116)
- **And** without WebGL or JavaScript the CSS liquid stays: only light moves in it (a highlight gliding through it, refracted light along its bottom), slowly (no loop shorter than 10 s), at a different pace and phase per meter
- **And** with reduced motion it is still (REQ-003-14)

### REQ-003-26 Stirring

- **Given** a meter with liquid drawn with WebGL (REQ-003-24) and no reduced motion
- **When** the pointer moves over it, or it is tapped on a phone
- **Then** the liquid swirls around the pointer, its front sloshes and more bubbles rise, more with faster movement
- **And** it calms down in about 2 s

### REQ-003-27 GitHub sign-in

- **Given** the dashboard is on and `dashboard.githubLogin` is not `false` (it is on by default)
- **When** a browser without a valid session opens a dashboard page
- **Then** it is sent to GitHub to sign in, with a random `state` kept in a short-lived cookie, and comes back to the page it asked for
- **And** a request that isn't a page navigation (a script's fetch, an asset) gets 401 instead
- **Given** the sign-in is on but has no client id and client secret file yet
- **Then** the pages answer 503 and say how to set it up, the Coordinator logs it, and `bun run doctor` reports it
- **Given** a configured client secret file that can't be read or is empty
- **When** the Coordinator starts
- **Then** it refuses to start

### REQ-003-28 Only the Owner

- **Given** a GitHub sign-in came back to the dashboard
- **When** the `state` matches and the GitHub user's id is `owner.id`
- **Then** the browser gets a session: an HttpOnly, SameSite=Strict cookie, signed with a key kept in the state dir, that ends after 30 days and survives a Coordinator restart; Secure when the browser came over HTTPS
- **And** any other user gets 403 and no dashboard content
- **And** a wrong or missing `state` (or code) gets 400 and nothing is asked of GitHub; a code GitHub refuses gets 400, GitHub out of reach 502
- **And** a tampered or expired session, one signed with another key, or one for another `owner.id` counts as none

### REQ-003-29 Sign out and other ways in

- **Given** a session
- **When** the Owner clicks "Sign out" in the header
- **Then** the session ends and a page offers to sign in again; a cross-site sign-out is refused
- **And** a configured token still works next to the sign-in, as a `Bearer` header (scripts) or the cookie set by `?token=`
- **And** off loopback, the Coordinator refuses to start when neither a token nor the GitHub sign-in is configured (REQ-003-07)

## Out of scope

- Write actions (approve, retry, merge, edit settings). Approval stays on GitHub, where the Owner's identity is checked.
- Exposing the dashboard on the public internet. The GitHub sign-in (REQ-003-27) is the login it would need, but remote access still goes through Tailscale or an SSH tunnel (`docs/setup.md`).
- More users than the Owner (an allow-list), and GitHub Apps' user tokens beyond what the OAuth web flow needs.
- HTTPS in the Coordinator itself; `tailscale serve` provides it.
- Full logs, tick history and transcripts. Recent Events are in scope (REQ-003-15, REQ-003-16); a "PR merged" Event is not, since the Coordinator does not act on merges.
- PR line counts and "time since review": the Tick snapshot doesn't carry them.
- A light theme: the design is dark only.

## Assumptions

- One Owner, one browser; no user accounts.
- The page is server-rendered and has no client-side data fetching: it reloads every poll interval anyway and must work without JavaScript (#72). An opened "Show N more" expander closes again on that reload (REQ-003-23); that is fine for a glance view.
- A view of the last tick (every `pollIntervalSec`) is fresh enough.
- 200 kept and 15 shown Events (5 at first, REQ-003-23) are enough to see what happened since the Owner last looked; no setting for either.
- The Owner reaches the server over Tailscale or an SSH tunnel; the GitHub sign-in guards it on top, so it is ready to be exposed later.
- The OAuth App's registered callback URL is the dashboard's URL + `/auth/callback`; the sign-in sends no `redirect_uri`, so GitHub always uses it.
- The fonts (Plus Jakarta Sans, Inter, JetBrains Mono) are served from the Coordinator under the SIL Open Font License; other scripts than Latin fall back to system fonts.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Result                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| REQ-003-01 | `dashboard view > REQ-003-01 …` (5 tests: fields incl. model and Remote Control name, running sessions first then idle then gone (#74), idle time as a bar and when it closes as text, reported vs configured model, window gone); `dashboard html > REQ-003-01 each session shows its model and its Remote Control name, with a copy button only for scripts`, `REQ-003-20 Activity …` (no "Working now" heading); `store > REQ-003-01 keeps when a session started …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 publishes a snapshot …`                                                                                                                                                    | pass                                                                                                               |
| REQ-003-02 | `dashboard view > REQ-003-02 …` (3 tests: seven columns in workflow order, status in words, PR with rounds/checks/mergeability); `dashboard html > REQ-003-02 the Pipeline shows seven columns …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 …`                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass                                                                                                               |
| REQ-003-03 | `dashboard view > REQ-003-03 …` (2 tests: the filter, a Bundle only when all its issues are reviewed); `dashboard html > REQ-003-11 lists the ready PRs next to the headline …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass                                                                                                               |
| REQ-003-04 | `scheduler > REQ-003-04 …` (2 tests: order and reasons, the pause); `dashboard view > REQ-003-04 …`; `dashboard html > REQ-003-04 the first step is marked next …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 …`, `REQ-003-04 an implement job without room …`                                                                                                                                                                                                                                                                                                                                                                                                                                | pass                                                                                                               |
| REQ-003-05 | `dashboard view > REQ-003-05 …` (2 tests: settings per Role and repository with overrides and access, without secrets; counts per repository); `dashboard html > REQ-003-05 …` (2 tests: the Config page, header links); `dashboard server > REQ-003-05 serves the Config page at /config`                                                                                                                                                                                                                                                                                                                                                                                                                 | pass                                                                                                               |
| REQ-003-06 | `dashboard view > REQ-003-06 …` (2 tests: last tick and reload, no tick yet); `dashboard html > REQ-003-06 a countdown to the next reload, and a meta refresh …`; `reconcile loop > REQ-003-06 a repository whose poll failed …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                               |
| REQ-003-07 | `config > REQ-003-07 …` (on by default on loopback and `false` turns it off; off loopback see REQ-003-29); `dashboard GitHub sign-in > REQ-003-07 … form-action 'self'`; `dashboard server > REQ-003-07 …` (7 tests: no server with `false`, 127.0.0.1:8080 without a block, 127.0.0.1, 401, token via header/cookie, GET only, unusable token file)                                                                                                                                                                                                                                                                                                                                                       | pass                                                                                                               |
| REQ-003-08 | `dashboard server > REQ-003-08 …` (3 tests: render exception, port in use, default port in use)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass                                                                                                               |
| REQ-003-09 | `dashboard view > REQ-003-09 text from GitHub and agents is escaped`; `dashboard html > REQ-003-09 both pages load only same-origin assets …`; `dashboard server > REQ-003-09 …` (2 tests: assets from a fixed list behind the token, the CSP)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass                                                                                                               |
| REQ-003-10 | Deprecated by spec 005; its tests were removed with the behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                  |
| REQ-003-11 | `dashboard view > REQ-003-11 sums up …`; `dashboard html > REQ-003-11 lists the ready PRs …`, `… the Overview shows its sections in order`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | pass                                                                                                               |
| REQ-003-12 | `dashboard view > REQ-003-12 shows used out of the limit …`; `dashboard html > REQ-003-12 shows each meter as used out of the limit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | pass                                                                                                               |
| REQ-003-13 | `dashboard view > REQ-003-13 a picked repository narrows the Pipeline …`; `dashboard html > REQ-003-13 the repository filter is a set of plain links …`; `dashboard server > REQ-003-13 ?repo= narrows the Pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | pass                                                                                                               |
| REQ-003-14 | `dashboard html > REQ-003-14 the animated background shows, also for reduced motion …` (checks the stylesheet and script; the behaviour in a browser is manual)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass (static); browser: open                                                                                       |
| REQ-003-15 | `store > REQ-003-15 …` (2 tests: newest first across a restart, cap at 200); `reconcile loop > REQ-003-15 records one Event per action …` (11 tests: Assessment, approval incl. blocked and unblock, block, PR opened and none on a failed `createPull`, Review with and without findings, Feedback round counted or not, failure with reason, a failing GitHub call records nothing, a store error is only logged); `Planner pass > REQ-003-15 …`, `Implementer run > REQ-003-15 …`, `Reviewer run > REQ-003-15 …` (failures inside the syncs)                                                                                                                                                            | pass                                                                                                               |
| REQ-003-16 | `dashboard view > REQ-003-16 …` (5 tests: order, limit, tone, time and links; tone per kind; repo filter; empty state; escaping); `dashboard html > REQ-003-16 Recent comes before Now in Activity …`, `… REQ-003-16 / REQ-003-23 Recent shows 5 of its 15 Events at every width …`, `… the Overview shows its sections in order`; `reconcile loop > REQ-003-16 the snapshot carries the recorded Events …`; desktop and phone screenshots on the PR                                                                                                                                                                                                                                                       | pass                                                                                                               |
| REQ-003-17 | `dashboard view > REQ-003-02 / REQ-003-17 says in words what is happening …` (tone per Pipeline status), `… REQ-003-16 / REQ-003-17 gives each kind of Event a tone …`; `dashboard html > REQ-003-17 red marks only failures, the attention tone only the Owner's move, and status text stays neutral`; contrast and the look: screenshots on the PR (#102)                                                                                                                                                                                                                                                                                                                                                | pass                                                                                                               |
| REQ-003-19 | `dashboard html > REQ-003-19 the stylesheet is built from its Tailwind source and has a rule for every class the pages use`; every other `dashboard html` / `dashboard view` / `dashboard server` test renders the React components                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass                                                                                                               |
| REQ-003-20 | `dashboard html > REQ-003-20 Activity: one header with the counts, Recent, Now and Next as one timeline, stacked Now, Next, Recent on a phone`, `… REQ-003-11 / REQ-003-12 / REQ-003-20 / REQ-003-02 the Overview shows its sections in order` (Activity holds the three parts, the band only the Pipeline and footer); no horizontal scroll at 360px measured in Chrome, desktop and phone screenshots on the PR (#104)                                                                                                                                                                                                                                                                                   | pass                                                                                                               |
| REQ-003-21 | `dashboard screenshots > REQ-003-21 the README shows every screenshot, and each is a committed PNG`, `… REQ-003-21 the pages are rendered from made-up data only …`; the images themselves: looked at after `bun run screenshots`, attached to the PR (#77)                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass                                                                                                               |
| REQ-003-22 | `dashboard screenshots > REQ-003-22 the fingerprint is stable for the same input and changes with the HTML or an asset`, `… REQ-003-22 the committed screenshots were made from the current dashboard …` (seen failing after a change to `styles.css` and to `html.tsx`, passing after `bun run screenshots`)                                                                                                                                                                                                                                                                                                                                                                                              | pass                                                                                                               |
| REQ-003-23 | `dashboard html > REQ-003-16 / REQ-003-23 Recent shows 5 of its 15 Events at every width …`, `… REQ-003-23 Next shows its first 5 steps …`, `… REQ-003-23 Now shows its first 5 sessions …`, `… REQ-003-23 a part with exactly 5 items has no expander`, `… REQ-003-23 the last item shown fades out until the rest is open …` (checks the stylesheet; each seen failing first); desktop and phone screenshots closed and open and no horizontal scroll at 360px on the PR (#109)                                                                                                                                                                                                                          | pass                                                                                                               |
| REQ-003-24 | `dashboard html > REQ-003-24 liquid glass meters > …` (8 tests: tube, liquid span and Slot marks for 4 of 5 with the aria values; empty, full and over-full; above 12 Slots no marks and tenths; an 18 px tube with a decorative canvas that the CSS liquid gives way to; Slot marks keep the faint line and are whiter over the liquid; the CSS fallback's light moves by transforms of 10 s or more, with its own pace and phase per meter; still for reduced motion; one WebGL context, about 30 frames a second, paused when hidden or out of view, a seed per meter); judged in Chrome (SwiftShader) by captures at 0, 4 and 8 s at real size and zoomed, desktop and phone, and without WebGL (#116) | pass; on a real GPU and phone: open                                                                                |
| REQ-003-26 | `dashboard html > REQ-003-26 the pointer stirs a meter's liquid, a tap on a phone too, and it calms down` (checks the script); a stir captured in Chrome (#116)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass (static); real pointer and tap: open                                                                          |
| REQ-003-27 | `dashboard GitHub sign-in > REQ-003-27 …` (4 tests: sent to GitHub with a random state in a Lax cookie, 401 for fetches and assets, unreadable or empty client secret refuses the start, 503 until set up); `config > REQ-003-27 …` (on by default, client id and secret file together, or `false`); `dashboard view > REQ-003-27 …` (on, off, not set up)                                                                                                                                                                                                                                                                                                                                                 | pass; with a real OAuth App: open                                                                                  |
| REQ-003-28 | `dashboard GitHub sign-in > REQ-003-27 / REQ-003-28 the Owner signs in …` and `REQ-003-28 …` (7 tests: another user 403, wrong or missing state 400, refused code 400 and GitHub out of reach 502, tampered/expired/foreign session, the key generated once (0600), a restart keeps the session unless `owner.id` changed, Secure behind HTTPS)                                                                                                                                                                                                                                                                                                                                                            | pass; with a real OAuth App: open                                                                                  |
| REQ-003-29 | `dashboard GitHub sign-in > REQ-003-29 …` (2 tests: Sign out ends the session and refuses a cross-site POST, the token next to the sign-in as Bearer, `?token=` and its cookie, also before the sign-in is set up); `dashboard html > REQ-003-29 …` (the Sign out form in the header); `config > REQ-003-29 …` (off loopback a token or the sign-in)                                                                                                                                                                                                                                                                                                                                                                                                                       | pass                                                                                                               |
| Acceptance | #72: desktop, phone and Config screenshots from fixture data before and after the React migration look the same; manual: open it on a phone over Tailscale and on desktop, compare with the mockup in #41, screenshots on the PR; without a `dashboard` block, an SSH tunnel to `127.0.0.1:8080` loads the page                                                                                                                                                                                                                                                                                                                                                                                            | #87: desktop and phone screenshots from fixture data match the mockup; on a real phone and the hover effects: open |
