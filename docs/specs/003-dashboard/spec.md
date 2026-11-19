# 003 – Dashboard

**Status:** Implemented

## Goal

The Owner wants to see at a glance, also on a phone, what the Coordinator is doing: which agents are running, what it did recently, where each issue stands, which agent PRs are ready to merge, what runs next and with which settings. Today that means opening GitHub, the Claude app and an SSH session. The dashboard is a web page served by the Coordinator itself. It changes nothing on GitHub or in the sessions, so approving, giving feedback and merging stay on GitHub, where only the Owner's actions count (REQ-001-01). The one thing it writes is the Owner's settings: limits, poll interval, models and the auto-merge mode can be changed on the Config page without editing `config.ts` and restarting (#123). Because the server runs agents that can push code, the page is private by default: only the Owner gets in, by signing in with GitHub (#115).

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
- **And** hovering an issue doesn't change the Pipeline's width: it scrolls sideways only when the columns don't fit, as on a phone (#121)

### REQ-003-03 Ready to merge

> **Deprecated** by REQ-003-32 (#111): the ready PRs are the first group of Your move; the rule below is unchanged there.

- **Given** an open agent PR whose issues are `agent:reviewed`, whose checks passed (or that has none) and that GitHub reports as mergeable
- **When** the dashboard is shown
- **Then** it is listed first, next to the Summary (REQ-003-11), with its title, repository, PR number and checks, linked to the PR

### REQ-003-04 Planned order

- **Given** the work the last tick queued
- **When** the dashboard is shown
- **Then** the queue is shown under "Next" in Activity (REQ-003-20) as a list of steps in the scheduler's order (REQ-001-08), the first one marked "next"
- **And** each item says whether it started in that tick or why it waits: the usage-limit pause (until when), `maxRunning`, the Role's Slots, its session being busy, `maxLiveSessions`, or `maxWorktrees`
- **And** approved issues that wait for open blockers are listed after it, marked as blocked, with the issues they are blocked by (REQ-001-05)

### REQ-003-05 Config page

- **Given** the Coordinator's config, with the Settings overrides laid over it (REQ-003-36)
- **When** the Owner opens the Config page (`/config`, a plain link in the page header)
- **Then** it shows a headline with the poll interval and the number of repositories
- **And** how the page is reached, taken from the config: host and port, whether the GitHub sign-in is on, off or not set up (REQ-003-29), whether a token is required, that it answers only GET (besides Sign out and saving settings) and makes no GitHub calls besides the sign-in's
- **And** the limits, the model and effort per Role with each repository's overrides, the Extra instructions that are set (REQ-003-42), and each repository with its setup command, its auto-merge mode (REQ-001-65) and its counts of open issues, agent PRs and Worktrees from the last tick
- **And** no secrets are shown: no private key (content or path), no dashboard token (content or path) and no GitHub client secret (content or path)

### REQ-003-06 Freshness

- **Given** the dashboard is open
- **When** a poll interval has passed
- **Then** it shows the current state, with a countdown to the next refresh (in place with JavaScript, REQ-003-28; without JavaScript it reloads, meta refresh)
- **And** the page has no "Last tick … · n min ago" line: the countdown's tooltip says when the last tick finished, or that none has finished yet (#117)
- **And** a repository whose poll failed in the last tick shows the error

### REQ-003-07 Access

- **Given** no `dashboard` block in the config
- **When** the Coordinator starts
- **Then** the dashboard listens on `127.0.0.1:8080` without a token, with the GitHub sign-in on (REQ-003-29)
- **Given** `dashboard: false` in the config
- **When** the Coordinator starts
- **Then** no server is started and nothing is logged as a failure
- **Given** a `dashboard` block without a host
- **Then** the server listens on `127.0.0.1` only
- **Given** a host other than a loopback address
- **When** no token is configured and the GitHub sign-in is off (`githubLogin: false`)
- **Then** the Coordinator refuses to start (REQ-003-31)
- **Given** a configured token
- **When** a request does not carry the token
- **Then** it gets 401 and no dashboard content
- **And** the server answers only GET requests (others get 405), `POST /auth/logout` (REQ-003-31) and `POST /config` (REQ-003-36), and serving a request changes nothing in the store, on GitHub or in the sessions
- **Given** a `POST /config`
- **When** it doesn't come from the Owner's signed-in session (REQ-003-30), comes from another site (`Sec-Fetch-Site` other than `same-origin`), or lacks the page's form token
- **Then** it is refused (401 without any access, 403 otherwise) and nothing changes: a token (REQ-003-31) gives read access only

### REQ-003-08 Isolation

- **Given** a running dashboard
- **When** serving a request fails (a bad request, an exception while rendering) or the server cannot be started
- **Then** the request gets an error response and the reconcile loop keeps running
- **And** the dashboard makes no GitHub requests of its own besides the GitHub sign-in's: the code exchange and `GET /user` (REQ-003-30), after which the user's access token is dropped; it shows the state of the last tick, and the Timings page the recorded Timings (REQ-003-34)

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
- **Then** a headline says how many items need the Owner: all items of Your move (REQ-003-32), e.g. "5 things need you", only the number in the accent colour; with none, "Nothing needs you right now"
- **And** three counts each say in a line what they mean: agents working (running sessions), jobs waiting for a slot (queued work that waits) and blocked (`blocked` issues)
- **And** the working count's line names the running Roles in Planner, Implementer, Reviewer order, with a count when there are several of one Role, e.g. "Implementer running now", "Planner and 2 Reviewers running now"; with none running it says "No agent running" (#147)
- **And** from the `md` width on, Your move (REQ-003-32) sits directly under the headline in the left, wider column, and the three counts with Capacity (REQ-003-12) under them form the right column (#139)
- **And** on a phone they stack in this order: headline, Your move, counts, Capacity

### REQ-003-12 Capacity

- **Given** the limits and the last tick
- **When** the Overview is shown
- **Then** there is one meter each for running sessions (`maxRunning`), live sessions (`maxLiveSessions`), the Slots of each Role (running sessions of that Role out of its `max…` limit) and Worktrees (`maxWorktrees`), each showing used out of the limit
- **And** the meters appear under the counts in the Summary (REQ-003-11), two per row, not as their own section under it (#139)

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
- **And** for reduced motion the background does not move with the scroll (REQ-003-25) and the comet scrollbar is a plain bar (REQ-003-27)

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
- **And** in the Summary (REQ-003-11) and Your move (REQ-003-32) the attention tone is not used: the Merge PRs icon is green, the Failed icon red, the other group icons and the headline's number use the accent (#111)
- **And** the open dropdown of a select (e.g. on the Config page) is dark with readable text in the browser's popup too, the selected option in the accent, "default" / "global (…)" muted but readable (#145)
- **And** in a select with option groups (e.g. a Role's model on the Config page) the open dropdown's group headers sit on the same dark background as the options, in the muted colour, and the hovered or keyboard-focused option is highlighted in the accent tone, not a light browser grey, while the closed select looks as before (#169)

### REQ-003-19 Component build

- **Given** the dashboard sources: React components and a Tailwind stylesheet
- **When** the Coordinator starts (`bun install && bun start`, no build step of the Owner's own)
- **Then** the pages are rendered on the server from the React components, and the stylesheet is built from its Tailwind source and served from the fixed list of files (REQ-003-09)
- **And** every class the pages use has a rule in that stylesheet

### REQ-003-20 Activity

- **Given** open sessions, queued work and recorded Events
- **When** the Owner opens the Overview
- **Then** one "Activity" section shows Recent, Now and Next as three parts of one timeline, each with a single heading and no second label repeating it (#146), Now marked as the current part by its glowing dot, under one header with the counts (running, idle, queued; the same as the Summary's _working_ and _queued_ counts)
- **And** on a wide screen they sit side by side in time order, Recent, Now, Next, joined by a line; on a phone they are stacked as Now, Next, Recent
- **And** Recent and Next share one row style (an icon, a line of text, a muted line under it), and Next is a vertical list, so the page has no horizontal scroll at 360px
- **And** the frosted band below Activity holds only the Pipeline and the footer

### REQ-003-21 README screenshots

- **Given** a fixed mock Tick snapshot (made-up repositories, issues, PRs, sessions and Events; nothing from this repository's issues), a mock config and a fixed clock
- **When** `bun run screenshots` runs on a host with Chrome or Chromium
- **Then** it renders the Overview at desktop and phone width and the Config and Timings pages at desktop width into `docs/images/`
- **And** every shot is one viewport-sized frame, not a full-page capture: 1280×800 at desktop width and 390×844 on the phone, both at 2× scale, so the desktop shots line up in the README (#149)
- **And** the README shows all of them: the Overview at the top, the Config and Timings pages in its Dashboard section

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

- **Given** the Overview shows Capacity (REQ-003-12) or the Usage quota (REQ-003-37)
- **When** a meter has used Slots
- **Then** its filled part is a liquid with rounded ends inside a glass tube (frosted, a lit rim and a static reflection), 18 px tall, its width used out of the limit: empty at 0, the whole tube when full
- **And** up to 12 Slots, Slot marks are etched into the glass as faint lines, above the liquid and a little whiter where they cross it, so they stay visible on it; above 12 there are none
- **And** with WebGL the liquid moves like a liquid: a rounded front that wobbles slightly, slow broad swirls, caustics and light, and no bubbles (#161). Each meter moves differently (its own phase, speed and pattern) and nothing repeats in under 10 s
- **And** it is drawn only while the tab is shown and Capacity or the Usage quota is in view, with one WebGL context for all meters (#116)
- **And** without WebGL or JavaScript the CSS liquid stays: only light moves in it (a highlight gliding through it, refracted light along its bottom), slowly (no loop shorter than 10 s), at a different pace and phase per meter
- **And** with reduced motion it is still (REQ-003-14)

### REQ-003-25 Background parallax

- **Given** the animated background is on (REQ-003-14)
- **When** the Owner scrolls
- **Then** the metal moves at about 30 % of the page's speed and the soft light and the indigo glows behind it at about 15 %, so the page reads as layers: content, metal, glow
- **And** scrolling stirs the metal the way moving the pointer does: the faster the scroll, the stronger the ripple, settling once the scrolling stops
- **And** the pointer's dent stays under the pointer and does not move with the scroll
- **And** without WebGL the glows still move at about 15 %
- **And** with reduced motion nothing moves with the scroll (REQ-003-14)

### REQ-003-26 Stirring

- **Given** a meter with liquid drawn with WebGL (REQ-003-24) and no reduced motion
- **When** the pointer moves over it, or it is tapped on a phone
- **Then** the liquid swirls around the pointer and its front sloshes, more with faster movement, with no bubbles (#161)
- **And** it calms down in about 2 s

### REQ-003-27 Comet scrollbar

- **Given** a dashboard page taller than the window and the dashboard script running
- **When** the Owner scrolls
- **Then** a comet replaces the browser's scrollbar: a thin, flowing indigo bar whose head is a white-hot plasma drop, round in front and pointed behind in the direction of the scroll, stretching as the scroll gets faster, with a tail behind it while scrolling
- **And** when the scroll direction flips, the head glides along the bar to its other end in about 0.3 s and turns round on the way, and the tail follows; nothing jumps, and a flip back during the glide reverses it smoothly (#126)
- **And** about a second after the scrolling or dragging stops it slims and dims, and the head fades out until it is invisible; it fades back in when scrolling or dragging starts, not on hover alone (#126)
- **And** it can be dragged with the mouse or a finger, and it catches no clicks or touches except on itself; the wheel, trackpad, keys and touch scroll as before
- **And** it is hidden when there is nothing to scroll
- **And** without the script the browser's own scrollbar stays
- **And** with reduced motion it is a plain bar: no flow, no tail and no head, so no stretch and no glide (REQ-003-14)
### REQ-003-28 In-place refresh

- **Given** the Overview or the Config page is open with JavaScript
- **When** the countdown reaches 0, or a hidden tab is shown again after that time
- **Then** the page loads its own URL again (with `?repo=`) and updates only the parts whose content changed
- **And** the animated background keeps running without fading in again, the scroll position and an opened "Show N more" (REQ-003-23) stay, and unchanged meters keep their animation
- **And** if the request fails, the shown content stays, the countdown turns red and says the refresh failed, and it tries again in the next interval
- **And** a 401, or a page made by another version of the Coordinator (other assets), reloads the whole page

### REQ-003-29 GitHub sign-in

- **Given** the dashboard is on and `dashboard.githubLogin` is not `false` (it is on by default)
- **When** a browser without a valid session opens a dashboard page
- **Then** it is sent to GitHub to sign in, with a random `state` kept in a short-lived cookie, and comes back to the page it asked for
- **And** a request that isn't a page navigation (a script's fetch, an asset) gets 401 instead
- **Given** the sign-in is on but has no client id and client secret file yet
- **Then** the pages answer 503 and say how to set it up, the Coordinator logs it, and `bun run doctor` reports it
- **Given** a configured client secret file that can't be read or is empty
- **When** the Coordinator starts
- **Then** it refuses to start

### REQ-003-30 Only the Owner

- **Given** a GitHub sign-in came back to the dashboard
- **When** the `state` matches and the GitHub user's id is `owner.id`
- **Then** the browser gets a session: an HttpOnly, SameSite=Strict cookie, signed with a key kept in the state dir, that ends after 30 days and survives a Coordinator restart; Secure when the browser came over HTTPS
- **And** any other user gets 403 and no dashboard content
- **And** a wrong or missing `state` (or code) gets 400 and nothing is asked of GitHub; a code GitHub refuses gets 400, GitHub out of reach 502
- **And** a tampered or expired session, one signed with another key, or one for another `owner.id` counts as none

### REQ-003-31 Sign out and other ways in

- **Given** a session
- **When** the Owner clicks "Sign out" in the header
- **Then** the session ends and a page offers to sign in again; a cross-site sign-out is refused
- **And** a configured token still works next to the sign-in, as a `Bearer` header (scripts) or the cookie set by `?token=`
- **And** off loopback, the Coordinator refuses to start when neither a token nor the GitHub sign-in is configured (REQ-003-07)

### REQ-003-36 Edit settings

- **Given** the Owner signed in with GitHub (REQ-003-29, REQ-003-30)
- **When** they open the Config page
- **Then** these settings are fields of a form, each showing its effective value: `pollIntervalSec`, `checksGraceSeconds`, every `limits` key, the model (from a list, REQ-003-40) and effort of each Role, globally and per repository (empty: the global one), and `autoMerge` (REQ-001-65) as a choice of `off`, `evaluated (low risk only)` and `all`, globally and in each repository's card, where a "global (…)" choice uses the global mode (#148)
- **And** a field whose value differs from `config.ts` says so, with the value from `config.ts`, and has a Reset button
- **And** repositories, Accounts, `owner`, `github`, `dashboard`, `stateDir` and `setup` commands can't be changed there (a `setup` command is code the server runs)
- **Given** the Owner changes fields and saves
- **When** the values are valid for the config (e.g. `maxRunning` not above `maxLiveSessions`; a model from the list, REQ-003-40)
- **Then** the values that differ from `config.ts` are written to `<stateDir>/config.overrides.json` (Settings overrides), the page says they were saved, and the Coordinator uses them from its next tick on, without a restart; a lowered limit closes nothing, fewer sessions are started
- **And** an invalid value shows the error next to the form, keeps the entered values, and nothing is saved
- **Given** the Owner presses Reset on a field
- **Then** its override is removed and `config.ts`'s value applies again; unsaved changes in other fields are dropped
- **Given** a Settings overrides file
- **When** the Coordinator starts or `bun run doctor` runs
- **Then** the overrides apply again; a file that isn't valid, or sets a key that can't be changed, stops the start and fails the doctor with the reason; without the file, `config.ts` applies alone

### REQ-003-32 Your move

- **Given** ready PRs (open agent PRs whose issues are all `agent:reviewed`, whose checks passed or that have none, and that GitHub reports as mergeable) and issues in `failed`, `needs-refinement`, `proposed` or `wontfix-proposed`
- **When** the Overview is shown
- **Then** a "Your move" panel next to the headline (REQ-003-11) lists them in groups, in this order: Merge PRs, Failed, Answer questions, Approve plans, Close?; a group with nothing in it is left out
- **And** the panel shows no visible title: the first group's heading (or the empty-state text) is the first thing in it, since the headline above already introduces it, and the first group has no hairline above it; a screen reader still announces the panel as "Your move" (#154)
- **And** each group has a bare icon (no circle or box around it), its name and its count, and the groups are split by a plain hairline
- **And** each row shows the title, the repository and the number (`PR #N` for a PR), and links to the PR or issue on GitHub; it gives no hint on what to do, since the group name says it (#139)
- **And** from the `sm` width on, the title and the line under it take one line each, cut with an ellipsis, with the full title on hover; on a phone rows are not indented and the title may take 2 lines
- **And** in the line under the title only the repository is ever cut, never the number or the checks fact
- **And** a ready PR's row shows its checks ("checks passed" or "no checks", with a green shield) at every width, also on a phone
- **And** hovering a row grows the green accent line in at its left edge, washes it green, nudges its text and turns the grey arrow circle green
- **And** with nothing to do it says "Nothing needs you" and when items will show up
- **And** it lists all repositories: the `?repo=` filter (REQ-003-13) narrows only the Pipeline and Recent
- **And** reviewed PRs with conflicts or pending checks are not listed: a Feedback round or the checks come first

### REQ-003-33 Timings recorded

- **Given** an issue the Coordinator works on
- **When** work for it is queued and started (a Planner pass, a revision, an Implementer run, a Review, a Feedback round), an agent session on it starts or stops running, the Owner replies to or approves its Assessment, its PR's checks finish for a new head, or the Owner merges its PR
- **Then** the store records each interval with the issue, its phase (Planning, Building, Review), its kind (queued, agent, checks, Owner), its Role, its round, its start and its end, and keeps it across a restart
- **And** the intervals of an issue follow on from each other: waiting for the Planner starts at the issue's creation and ends when the Planner pass starts; waiting for an Implementer starts at the approval; the Owner's time starts when the turn before it ended and ends at the Owner's reply or approval (or when the merge was seen); checks run alongside the Review (REQ-001-64): they start when the Coordinator first sees the pushed head and end when it sees them finished (once per head, with no duration if they had already finished), as precise as the poll interval, and the next step's wait does not start after them
- **And** an agent interval counts only the time its session was running, not idle time; a session that stops without a hook (a crash, a closed window) has its interval closed when a Tick notices it
- **And** a start that failed and is tried again stays the same round
- **And** issues worked on before this was recorded are not filled in (no backfill)

### REQ-003-34 Timings page

- **Given** recorded Timings
- **When** the Owner opens the Timings tab (`/timings`), next to Overview and Config, and picks an issue (a list of the issues with Timings, newest first, and a "Show" button, so it works without JavaScript; with JavaScript it shows the pick right away; without a pick the newest issue)
- **Then** each phase is a row of segments in time order, proportional on one scale for all rows, with a label and a duration for each under the bar (e.g. "Waited for the Planner 14 min", "Planner", "Revise 1", "Checks", "Reviewer", "Feedback round 1")
- **And** totals above the rows: the time without the Owner's, the agents' working time and the number of Revise and Feedback rounds; time that overlaps (checks alongside the Review) counts once
- **And** the Owner's time ("Your reply", "Your approval", "Your merge") is left out of the bars and the total unless "Include your time" is ticked; then the total is "end to end"
- **And** a running agent's segment grows until now
- **And** an issue with nothing recorded says so, and so does the page while nothing is recorded at all
- **And** access is the same as the Overview's (REQ-003-07); the page reads Timings from the store but writes nothing; on a phone the page has no horizontal scroll

### REQ-003-35 One "Show more" for Your move

- **Given** more than 6 items in Your move (REQ-003-32), across all groups
- **When** the Overview is shown, at any width
- **Then** the first 5 items show in group order, the 5th fading out downwards, with one "Show N more" at the bottom of the panel
- **And** following it shows the rest in place, each continuing its group without repeating the group's heading, with "Show less" under them; it needs no JavaScript, like REQ-003-23
- **And** with 6 or fewer items all show, so there is never a "Show 1 more"
- **And** the headline's count (REQ-003-11) and each group's count stay the totals, not the visible items

### REQ-003-37 Usage quota on the Overview

- **Given** a session on an Account has reported its Usage quota (REQ-001-67)
- **When** the Overview is shown
- **Then** under the Capacity meters (REQ-003-12), a section headed **Usage quota**, in the same style as the Capacity heading, shows two meters per Account, side by side: _5-hour window_ and _Weekly_ (#161)
- **And** they use the same glass tube and liquid as Capacity (REQ-003-24, so with WebGL they move and can be stirred, REQ-003-26), filled to the percent used to the nearest 10 %, with no Slot marks
- **And** the value reads the whole percent, e.g. **38**% used; from 90 % it is accent purple (REQ-003-17, never gold)
- **And** a faint line under the meters says whose quota it is and when the windows reset, e.g. "Claude subscription · resets in 3 h 12 min and Fri 09:00 UTC"
- **And** the meters' tooltip says how old the values are, e.g. "as of 4 min ago"
- **And** on a phone the two meters stay side by side, and there is no horizontal scroll at 360 px

### REQ-003-38 Usage quota of several Accounts, a paused Account, no report

- **Given** several Accounts, a paused Account (REQ-001-17), or no report yet
- **When** the Overview is shown
- **Then** with several Accounts the Account's name is a small label above its pair of meters; with a single Account the name is left out
- **And** a paused Account shows "paused until 14:30 UTC" instead of its meters
- **And** a window that was never reported, or whose reset time has passed, shows "–" with an empty tube
- **And** with no report and no pause at all, the section says "Shown once a session has reported its usage"

### REQ-003-39 Fixed frosted header

- **Given** any dashboard page (Overview, Config, Timings), on a desktop or a phone
- **When** the Owner scrolls down
- **Then** the header stays at the top of the viewport as a full-width frosted bar: the page shows through it blurred and dimmed, it has a thin bottom edge, and its text stays readable over any content; the alerts under it scroll with the page
- **And** on a phone it is a single row: logo icon, tabs, countdown ring, and Sign out as an icon button that keeps "Sign out" as its accessible name. The wordmark and the Read-only pill are hidden there (the footer already says read-only), and below 380 px the countdown keeps only its ring. There is no horizontal scroll at 360 and 390 px
- **And** jumping to an anchor (e.g. `/#pipeline` from the repository filter) puts the heading below the bar, not under it

### REQ-003-40 Model is chosen from a list

Changes REQ-003-36, where a model was any name (#159).

- **Given** the signed-in Owner on the Config page
- **When** they edit a Role's model, globally or in a repository
- **Then** it's a select of the Model catalogue: each family as an alias, e.g. "Opus (latest)", followed by "· now Opus 5.5" once a session has reported a model of that family (the newest reported, REQ-001-29), and as a pinned version, e.g. "Opus 5.5" for `claude-opus-5-5`. A repository's field also offers "global (…)", naming the global model
- **And** a value that isn't in the catalogue, from `config.ts` (e.g. `opus[1m]`) or from a saved Settings override, shows as its own option, so the page never hides or changes it
- **Given** the Owner saves a model
- **When** it is neither in the catalogue nor the field's value from `config.ts` or the saved overrides
- **Then** saving is refused with "must be a model from the list", and nothing is saved
- **And** `config.ts` and a Settings overrides file at startup still accept any model name, so a new model works before the catalogue lists it

### REQ-003-41 Models shown by name

- **Given** a model id or alias on the dashboard: a session's model on the Overview, the Models table and the model choices on the Config page
- **When** it's rendered
- **Then** it reads "Opus 5.5" for `claude-opus-5-5`, "Opus (latest)" for the alias `opus`, with ", 1M context" for a `[1m]` suffix; a value it doesn't know stays as it is
- **And** the raw value is the element's `title`, on hover
- **And** what `claude --model` gets and the agent note (REQ-001-29) don't change

### REQ-003-42 Edit Extra instructions

Extends REQ-003-36 (#156).

- **Given** the signed-in Owner on the Config page
- **When** they open it
- **Then** each Role has a text field for its Extra instructions (REQ-002-17), globally and in each repository (folded away while a repository has none), with a note that they are added after the Role prompt
- **Given** the Owner edits them and saves
- **Then** the text is stored in the Settings overrides (an empty text also replaces one from `config.ts`) and used by sessions started from then on; running and resumed sessions keep the prompt they started with
- **And** a changed field says so and has a Reset button, as the other settings
- **And** a text over 4,000 characters is refused with "must be at most 4,000 characters", the entered text stays in the form, and nothing is saved; `config.ts` and the overrides file at startup are held to the same limit
- **Given** read-only access (a token)
- **Then** the Config page lists the Extra instructions that are set, by Role and repository, with no field to change them

## Out of scope

- Write actions besides the settings of REQ-003-36 (approve, retry, merge). Approval stays on GitHub, where the Owner's identity is checked.
- Editing repositories, Accounts, access settings or `setup` commands on the Config page, and a restart button (it would interrupt running sessions).
- Picking up a Settings overrides file edited or deleted by hand while the Coordinator runs: it is read at the start.
- Exposing the dashboard on the public internet. The GitHub sign-in (REQ-003-29) is the login it would need, but remote access still goes through Tailscale or an SSH tunnel (`docs/setup.md`).
- More users than the Owner (an allow-list), and GitHub Apps' user tokens beyond what the OAuth web flow needs.
- HTTPS in the Coordinator itself; `tailscale serve` provides it.
- Timings across issues (a benchmark chart) and of work from before Timings were recorded (#125).
- Full logs, tick history and transcripts. Recent Events are in scope (REQ-003-15, REQ-003-16); a "PR merged" Event is not, since the Coordinator does not act on merges.
- Fetching the Usage quota from an API: it comes only from sessions' status lines (REQ-001-67), so it is as fresh as the last session that ran on the Account.
- PR line counts and "time since review": the Tick snapshot doesn't carry them.
- A light theme: the design is dark only.
- Fetching the Model catalogue from the Anthropic Models API: it needs an API key that a Claude subscription doesn't have. The catalogue is a list in `src/models.ts`, updated when a model ships.

## Assumptions

- One Owner, one browser; no user accounts.
- Settings overrides of a repository no longer in `config.ts` are ignored, and dropped at the next save.
- `Sec-Fetch-Site`, the SameSite=Strict session cookie and a form token bound to the session keep other sites from saving settings; the `Origin` header is not compared, since behind `tailscale serve` the server doesn't know its public origin.
- The page is rendered only on the server and must work without JavaScript (#72). With JavaScript it fetches its own HTML and patches the page in place (REQ-003-28), so there is no client build and no second data contract; without, it reloads every poll interval and an opened "Show N more" closes again, which is fine for a glance view.
- A view of the last tick (every `pollIntervalSec`) is fresh enough.
- 200 kept and 15 shown Events (5 at first, REQ-003-23) are enough to see what happened since the Owner last looked; no setting for either.
- The Owner reaches the server over Tailscale or an SSH tunnel; the GitHub sign-in guards it on top, so it is ready to be exposed later.
- The OAuth App's registered callback URL is the dashboard's URL + `/auth/callback`; the sign-in sends no `redirect_uri`, so GitHub always uses it.
- The fonts (Plus Jakarta Sans, Inter, JetBrains Mono) are served from the Coordinator under the SIL Open Font License; other scripts than Latin fall back to system fonts.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Result                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| REQ-003-01 | `dashboard view > REQ-003-01 …` (5 tests: fields incl. model and Remote Control name, running sessions first then idle then gone (#74), idle time as a bar and when it closes as text, reported vs configured model, window gone); `dashboard html > REQ-003-01 each session shows its model and its Remote Control name, with a copy button only for scripts`, `REQ-003-20 Activity …` (no "Working now" heading); `store > REQ-003-01 keeps when a session started …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 publishes a snapshot …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass                                                                                                               |
| REQ-003-02 | `dashboard view > REQ-003-02 …` (3 tests: seven columns in workflow order, status in words, PR with rounds/checks/mergeability); `dashboard html > REQ-003-02 the Pipeline shows seven columns …`, `… REQ-003-02 hovering a card doesn't widen the Pipeline …`; `bun run check:pipeline-hover` (#121, needs Chrome, not in `bun test`: hovers every issue at 1280 px and requires the Pipeline's `scrollWidth` = `clientWidth`, and that it still scrolls at 390 px; seen failing with `1170 > 1168` on the last Failed issue without the fix, passing with it); `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass                                                                                                               |
| REQ-003-03 | Deprecated by REQ-003-32; its tests moved there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                               |
| REQ-003-04 | `scheduler > REQ-003-04 …` (2 tests: order and reasons, the pause); `dashboard view > REQ-003-04 …`; `dashboard html > REQ-003-04 the first step is marked next …`; `reconcile loop > REQ-003-01 / REQ-003-02 / REQ-003-04 …`, `REQ-003-04 an implement job without room …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass                                                                                                               |
| REQ-003-05 | `dashboard view > REQ-003-05 …` (2 tests: settings per Role and repository with overrides and access, without secrets; counts per repository), `REQ-001-65 / REQ-003-05 shows each repository's effective auto-merge mode`; `dashboard html > REQ-003-05 …` (2 tests: the Config page, header links); `dashboard server > REQ-003-05 serves the Config page at /config`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass                                                                                                               |
| REQ-003-06 | `dashboard view > REQ-003-06 …` (2 tests: the last tick in the countdown's tooltip and the poll interval, no tick yet); `dashboard html > REQ-003-06 a countdown to the next refresh, and a meta refresh …` (both pages), `… REQ-003-06 no Last tick line …`; `reconcile loop > REQ-003-06 a repository whose poll failed …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | pass                                                                                                               |
| REQ-003-07 | `dashboard settings > REQ-003-07 …` (3 tests: a POST without or with a wrong form token or from another site 403; a token (Bearer or cookie) 403, no access 401; sign-in off 403), `… REQ-003-07 / REQ-003-36 a token gives the Config page read-only`; `config > REQ-003-07 …` (on by default on loopback and `false` turns it off; off loopback see REQ-003-31); `dashboard GitHub sign-in > REQ-003-07 … form-action 'self'`; `dashboard server > REQ-003-07 …` (7 tests: no server with `false`, 127.0.0.1:8080 without a block, 127.0.0.1, 401, token via header/cookie, GET only, unusable token file)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | pass                                                                                                               |
| REQ-003-08 | `dashboard server > REQ-003-08 …` (3 tests: render exception, port in use, default port in use)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                               |
| REQ-003-09 | `dashboard view > REQ-003-09 text from GitHub and agents is escaped`; `dashboard html > REQ-003-09 both pages load only same-origin assets …`; `dashboard server > REQ-003-09 …` (2 tests: assets from a fixed list behind the token, the CSP)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass                                                                                                               |
| REQ-003-10 | Deprecated by spec 005; its tests were removed with the behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                  |
| REQ-003-11 | `dashboard view > REQ-003-11 sums up what needs the Owner, running sessions, work waiting for a slot and blocked issues`, `… REQ-003-11 the working count's line names the running Roles in Planner, Implementer, Reviewer order` (#147); `dashboard html > REQ-003-11 the headline says how many things need the Owner …`, `… REQ-003-11 one thing needs the Owner, or nothing`, `… the Overview shows its sections in order`; `… REQ-003-11 / REQ-003-12 Your move sits under the headline on the left, the counts with Capacity under them on the right`; desktop and phone screenshots on the PR (#111, #139)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass                                                                                                               |
| REQ-003-12 | `dashboard view > REQ-003-12 shows used out of the limit …`; `dashboard html > REQ-003-12 shows each meter as used out of the limit`, `… REQ-003-11 / REQ-003-12 Your move sits under the headline …` (the meters inside `#summary`, two per row, no Capacity section)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass                                                                                                               |
| REQ-003-13 | `dashboard view > REQ-003-13 a picked repository narrows the Pipeline …`; `dashboard html > REQ-003-13 the repository filter is a set of plain links …`; `dashboard server > REQ-003-13 ?repo= narrows the Pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | pass                                                                                                               |
| REQ-003-14 | `dashboard html > REQ-003-14 the animated background shows, also for reduced motion …` (checks the stylesheet and script; the behaviour in a browser is manual)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass (static); browser: open                                                                                       |
| REQ-003-15 | `store > REQ-003-15 …` (2 tests: newest first across a restart, cap at 200); `reconcile loop > REQ-003-15 records one Event per action …` (11 tests: Assessment, approval incl. blocked and unblock, block, PR opened and none on a failed `createPull`, Review with and without findings, Feedback round counted or not, failure with reason, a failing GitHub call records nothing, a store error is only logged); `Planner pass > REQ-003-15 …`, `Implementer run > REQ-003-15 …`, `Reviewer run > REQ-003-15 …` (failures inside the syncs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                               |
| REQ-003-16 | `dashboard view > REQ-003-16 …` (5 tests: order, limit, tone, time and links; tone per kind; repo filter; empty state; escaping); `dashboard html > REQ-003-16 Recent comes before Now in Activity …`, `… REQ-003-16 / REQ-003-23 Recent shows 5 of its 15 Events at every width …`, `… the Overview shows its sections in order`; `reconcile loop > REQ-003-16 the snapshot carries the recorded Events …`; desktop and phone screenshots on the PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | pass                                                                                                               |
| REQ-003-17 | `dashboard view > REQ-003-02 / REQ-003-17 says in words what is happening …` (tone per Pipeline status), `… REQ-003-16 / REQ-003-17 gives each kind of Event a tone …`; `dashboard html > REQ-003-17 red marks only failures, the attention tone only the Owner's move, and status text stays neutral`, `… REQ-003-32 / REQ-003-17 the PR icon is green, Failed red, the others in the accent, no gold …`, `… REQ-003-17 the dropdown of a select is dark with readable text, not the browser's white popup (#145)`, `… REQ-003-17 the group headers of a select's dropdown sit on the dark background in the muted colour, and the hovered option is in the accent (#169)`; contrast and the look: screenshots on the PR (#102, #145, #169)                                                                                                                                                                                                                                                                                                                                                                                                                                              | pass                                                                                                               |
| REQ-003-19 | `dashboard html > REQ-003-19 the stylesheet is built from its Tailwind source and has a rule for every class the pages use`; every other `dashboard html` / `dashboard view` / `dashboard server` test renders the React components                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | pass                                                                                                               |
| REQ-003-20 | `dashboard html > REQ-003-20 Activity: one header with the counts, Recent, Now and Next as one timeline, stacked Now, Next, Recent on a phone` (single heading per part, #146), `… REQ-003-11 / REQ-003-12 / REQ-003-20 / REQ-003-02 the Overview shows its sections in order` (Activity holds the three parts, the band only the Pipeline and footer); no horizontal scroll at 360px measured in Chrome, desktop and phone screenshots on the PR (#104)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | pass                                                                                                               |
| REQ-003-21 | `dashboard screenshots > REQ-003-21 the README shows every screenshot, and each is a committed PNG`, `… REQ-003-21 every shot is a viewport-sized frame …` (seen failing on the full-page captures, #149), `… REQ-003-21 the pages are rendered from made-up data only …`; the images themselves: looked at after `bun run screenshots`, attached to the PR (#77, #149)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass                                                                                                               |
| REQ-003-22 | `dashboard screenshots > REQ-003-22 the fingerprint is stable for the same input and changes with the HTML or an asset`, `… REQ-003-22 the committed screenshots were made from the current dashboard …` (seen failing after a change to `styles.css` and to `html.tsx`, passing after `bun run screenshots`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass                                                                                                               |
| REQ-003-23 | `dashboard html > REQ-003-16 / REQ-003-23 Recent shows 5 of its 15 Events at every width …`, `… REQ-003-23 Next shows its first 5 steps …`, `… REQ-003-23 Now shows its first 5 sessions …`, `… REQ-003-23 a part with exactly 5 items has no expander`, `… REQ-003-23 the last item shown fades out until the rest is open …` (checks the stylesheet; each seen failing first); desktop and phone screenshots closed and open and no horizontal scroll at 360px on the PR (#109)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass                                                                                                               |
| REQ-003-24 | `dashboard html > REQ-003-24 liquid glass meters > …` (9 tests: tube, liquid span and Slot marks for 4 of 5 with the aria values; empty, full and over-full; above 12 Slots no marks and tenths; an 18 px tube with a decorative canvas that the CSS liquid gives way to; Slot marks keep the faint line and are whiter over the liquid; the CSS fallback's light moves by transforms of 10 s or more, with its own pace and phase per meter; still for reduced motion; one WebGL context, about 30 frames a second, paused when hidden or out of view, a seed per meter; no bubbles and the Usage quota's tubes picked up and observed, #161); judged in Chrome (SwiftShader) by captures at 0, 4 and 8 s at real size and zoomed, desktop and phone, and without WebGL (#116, #161)                                                                                                                                                                                                                                                                                                                                                                                                     | pass; on a real GPU and phone: open                                                                                |
| REQ-003-25 | `dashboard html > REQ-003-25 background parallax > …` (3 tests: the shader shifts the folds by `scroll` at `METAL = 0.3` and the light by `GLOW = 0.15` while the dent stays at `p-m`; the scroll speed feeds the dent's energy; the glows sit on their own fixed layer moved by `--glow-y`, set before the WebGL check, and reduced motion stops it); in Chrome: screenshots at scroll 0 and 450 on the PR, and without WebGL the glows moved (#110)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | pass                                                                                                               |
| REQ-003-26 | `dashboard html > REQ-003-26 the pointer stirs a meter's liquid, a tap on a phone too, and it calms down` (checks the script, no bubbles); a stir captured in Chrome (#116)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass (static); real pointer and tap: open                                                                          |
| REQ-003-27 | `dashboard html > REQ-003-27 comet scrollbar > …` (7 tests: the native bar is hidden only via the `has-comet` class the script sets; pointers caught only by the thumb, drag via pointer capture, passive scroll listener and no wheel/key/touch handlers; plasma-drop head stretched by `--stretch`, tail by `--tail`, flow only while scrolling, hidden with nothing to scroll; scrolling up the drop turns round but stays on the bar's end; a direction flip glides the head by `translate` (by `--thumb-h`; down is the base state, also before the first scroll) and turns the drop with transitions; at rest the head's opacity is 0, hover doesn't light it; reduced motion: no tail, no head, no flow); in Chrome: zoomed captures of the head at rest, slow, fast, up and reduced motion, drag and the speed decay checked, desktop and phone screenshots on the PR (#110); a flip seeked frame by frame (0, 60, 120, 180, 300 ms) and at rest captured on the PR (#126)                                                                                                                                                                                                        | pass                                                                                                               |
| REQ-003-28 | `dashboard refresh > REQ-003-28 …` (7 tests in happy-dom running the real script on rendered pages: own URL with `?repo=`, changed text updated, `#bg`, header, comet, meters and a ticked "Show N more" kept; meter canvases untouched and `dashboard:refreshed` sent; network error and HTTP 500 keep the content and mark the countdown, the next interval recovers; 401 and other assets reload; a hidden tab waits); `dashboard html > REQ-003-28 a failed refresh turns the countdown red`; `dashboard server > REQ-003-09 / REQ-003-28 … fetches only itself …` (`connect-src 'self'`, no other directive); in Chrome: several refreshes, server stopped once (#117)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass                                                                                                               |
| REQ-003-29 | `dashboard GitHub sign-in > REQ-003-29 …` (4 tests: sent to GitHub with a random state in a Lax cookie, 401 for fetches and assets, unreadable or empty client secret refuses the start, 503 until set up); `config > REQ-003-29 …` (on by default, client id and secret file together, or `false`); `dashboard view > REQ-003-29 …` (on, off, not set up)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass; with a real OAuth App: open                                                                                  |
| REQ-003-30 | `dashboard GitHub sign-in > REQ-003-29 / REQ-003-30 the Owner signs in …` and `REQ-003-30 …` (7 tests: another user 403, wrong or missing state 400, refused code 400 and GitHub out of reach 502, tampered/expired/foreign session, the key generated once (0600), a restart keeps the session unless `owner.id` changed, Secure behind HTTPS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass; with a real OAuth App: open                                                                                  |
| REQ-003-31 | `dashboard GitHub sign-in > REQ-003-31 …` (2 tests: Sign out ends the session and refuses a cross-site POST, the token next to the sign-in as Bearer, `?token=` and its cookie, also before the sign-in is set up); `dashboard html > REQ-003-31 …` (the Sign out form in the header); `config > REQ-003-31 …` (off loopback a token or the sign-in)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | pass                                                                                                               |
| REQ-003-36 | `Settings overrides > REQ-003-36 …` (8 tests: no file, merge of every editable key, a repository's `null`, `autoMerge` globally and per repository with a repository's `null` falling back to the global mode, unknown repositories ignored, invalid file and non-editable keys refused (incl. `setup`, a model that is an option), save validates, writes and survives a restart, empty overrides); `dashboard settings > REQ-003-36 …` (5 tests: the form with its token and only the editable fields and no refresh, saving writes only differences and marks them with config.ts's value and Reset, `autoMerge` as a select globally and per repository that saves, goes back to the global mode and refuses an unknown mode, an invalid value keeps the entered values and saves nothing, Reset removes one override); `reconcile loop with Settings overrides > REQ-003-36 …` (a lowered `maxRunning` and another model apply at the next tick); `worktrees > REQ-003-36 maxWorktrees is read on every check …`; manual: `bun run doctor` with a valid and an invalid overrides file, and save / invalid save in headless Chrome against the real server (screenshots on #123's PR) |
| REQ-003-32 | `dashboard view > REQ-003-32 …` (4 tests: the ready-PR filter, a Bundle only when all its issues are reviewed, groups in order with rows, labels and hints, empty groups left out); `dashboard html > REQ-003-32 …` (6 tests: groups with icon, name and count and linked rows, no visible title but a screen-reader name, the first group first in the panel (#154); one line each from sm on with the full title as `title`, no hint, only the repository cut (#139); a ready PR's checks fact at every width with a green shield; every row has the green accent line, wash, nudge and arrow hover; tones and hairlines, none above the first group; the empty state first in the panel); `dashboard server > REQ-003-13 ?repo= narrows the Pipeline` (Your move stays unfiltered); in Chrome: desktop and phone screenshots with the first row hovered (forced `:hover`), no horizontal scroll at 360px (#111); without the title, with items and with none: screenshots on the PR (#154)                                                                                                                                                                                             | pass; the hover in a real browser: open                                                                            |
| REQ-003-33 | `store > Timings > REQ-003-33 …` (5 tests: a step's wait and only running time as agent time, a session's time goes to the step that began last across phases, survives a restart and a crash's interval closed at the next Tick, a retried start is the same round and the next starts at the last end, the Owner's time fills the gap since the last step, checks run alongside from their head's push once per head, never without Timings); `reconcile loop > REQ-003-33 one issue through plan, revision, approval, Implementer, checks, Review, Feedback round, re-review and merge`, `… a session whose window is gone …`; `hook > REQ-003-33 …`; `deriveActions > REQ-001-14 / REQ-003-33 …` (merged or closed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass                                                                                                               |
| REQ-003-34 | `dashboard timings > REQ-003-34 …` (9 tests: rows, labels, shares on one scale, totals without the Owner's time; with it end to end; one segment per step, running grows, under a second left out; checks alongside the Review count once; picker newest first, empty states; tab, GET form, `width` attributes and no `style`, empty page); `store > Timings > REQ-003-34 lists the issues …`; `dashboard server > REQ-003-34 …` (2 tests: from the store behind the token, no source); `dashboard refresh > REQ-003-34 …` (submits on change); no horizontal scroll at 360 and 390 px measured in Chrome, screenshots on the PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass                                                                                                               |
| REQ-003-35 | `dashboard html > REQ-003-35 …` (4 tests: 11 items show 5 and one "Show 6 more", counts stay totals, the 5th fades; a split group keeps one heading and a later group brings its own; 6 or fewer show all with no expander; the fade rule in the stylesheet; each seen failing first); `dashboard refresh > REQ-003-28 / REQ-003-35 an opened "Show N more" in Your move stays open`; desktop and phone screenshots with 11 items on the PR (#139)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass                                                                                                               |
| REQ-003-37 | `dashboard view > REQ-003-37 …` (2 tests: percent, reset line and age; marked from 90 %); `dashboard html > REQ-003-37 …` (3 tests: heading under Capacity in its style; two meters in the Capacity tube, tenths without Slot marks, side by side, no pill or bars; accent from 90 % and no gold, the reset line under the meters, the age as tooltip); `reconcile loop > REQ-001-67 / REQ-003-37 …` (snapshot); in Chrome: no horizontal scroll at 360, 390 and 1280 px, the quota liquid moving; screenshots on the PR (#161)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                               |
| REQ-003-38 | `dashboard view > REQ-003-38 …` (3 tests: names, pause and – for a stale or missing window; a pause on another day; nothing to show); `dashboard html > REQ-003-38 …` (3 tests: the name above each pair, paused instead of meters, – with an empty tube; no name for a single Account; the empty note); screenshot with two Accounts on the PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                               |
| REQ-003-39 | `dashboard html > REQ-003-39 fixed frosted header > …` (4 tests: the sticky bar on all three pages with its content in the page column; one row on a phone with wordmark, Read-only and below 380 px the countdown text hidden; Sign out icon-only with its accessible name; the stylesheet's sticky, z-index, frost incl. `-webkit-`, bottom edge, safe area and anchor offset; each seen failing first), `… REQ-003-31 …` (Sign out's label now in a span); in headless Chrome on all three pages at 1280, 390 and 360 px: scrolled down, the header's top is 0, it is 59/56 px tall and nothing scrolls horizontally; screenshots on the PR. Not verified: a real iPhone (notch, Safari's backdrop-filter)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass                                                                                                               |
| REQ-003-40 | `Model catalogue > REQ-003-40 …` (3 tests: aliases and pinned versions, only catalogue values in it, an alias names the newest reported version); `store > REQ-003-40 lists the models the sessions reported …`; `dashboard settings > REQ-003-40 …` (4 tests: a select of the catalogue globally and in a repository with "global (…)" and "· now Opus 5.5"; a `config.ts` value outside it stays an option and saving keeps it; an unlisted model is refused and nothing saved, a listed one saves; a saved override outside it still loads, stays selected and other fields save); screenshots on the PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass                                                                                                               |
| REQ-003-41 | `Model catalogue > REQ-003-41 …` (labels of ids, aliases, `[1m]` and unknown values); `dashboard view > REQ-003-01 …` and `REQ-003-05 / REQ-003-41 …` (`modelName` of sessions and Roles); `dashboard html > REQ-003-01 …` (the session line by name, the id as `title`) and `REQ-003-05 …` (the Models table); screenshots on the PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | pass                                                                                                               |
| REQ-003-42 | `Settings overrides > REQ-003-42 …` (2 tests: global and per repository, an empty text replacing `config.ts`'s; the size limit refuses and saves nothing); `dashboard settings > REQ-003-42 …` (4 tests: a textarea per Role globally and per repository with the note; save with CRLF kept as LF and `{{x}}` as is, changed marks, Reset; over the limit refused with the text kept and nothing saved; a token sees the text without a field); `dashboard view > REQ-003-42 …`; `REQ-003-07 a token never saves settings …` (unchanged); screenshots on the PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass                                                                                                               |
| Acceptance | #72: desktop, phone and Config screenshots from fixture data before and after the React migration look the same; manual: open it on a phone over Tailscale and on desktop, compare with the mockup in #41, screenshots on the PR; without a `dashboard` block, an SSH tunnel to `127.0.0.1:8080` loads the page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | #87: desktop and phone screenshots from fixture data match the mockup; on a real phone and the hover effects: open |
