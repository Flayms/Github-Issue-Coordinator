# 003 – Dashboard: Plan

## Approach

**In the Coordinator process.** The queue and the reasons work waits exist only in memory during a tick, so a separate process reading SQLite could not show the planned order. The dashboard is a `Bun.serve` server started next to the loop in `src/index.ts`.

**Tick snapshot.** At the end of every tick the Coordinator publishes a `TickSnapshot` in one assignment (so a request never sees half a tick): the in-scope issues and open agent PRs per repository with their PR state (head, checks, mergeability) and Feedback rounds, the open sessions with whether their tmux window is alive, the queue in the scheduler's order with a wait reason per item, the usage-limit pause and the poll error per repository. The dashboard reads only this snapshot and the config. It makes no GitHub calls and no store writes, so it costs no rate limit and cannot change what the loop decides. Building the snapshot is wrapped so that a failure there is logged and never breaks the tick.

**Wait reasons.** `schedule()` stays pure and its decisions unchanged; its `Plan` additionally lists the whole queue in its sorted order with the reason each item that does not start waits (`paused`, `max-running`, `slot`, `session-busy`, `max-live-sessions`). `maxWorktrees` is only known when the implement job runs (`worktrees.hasRoom()`); the job returns that reason and the Coordinator records it. Blocked issues are never queued; the snapshot carries their open blockers from the Assessment, and the view lists them after the queue.

**View model and HTML.** `src/dashboard/view.ts` turns a snapshot and the config into a plain view model (pure, unit-tested): sessions, ready-to-merge PRs, pipeline columns in workflow order, the queue, blocked issues and redacted settings. Settings use an allow-list (only fields named in the view), so a secret added to the config later is not shown by default. `src/dashboard/html.ts` renders it server-side: one mobile-first page with inline CSS, every value HTML-escaped, and `<meta http-equiv="refresh">` every poll interval instead of a script (deviation from the Assessment's "small refresh script": no script is simpler and lets the CSP forbid scripts altogether).

**Server and access.** `src/dashboard/server.ts`:

- No `dashboard` block → not started. Host defaults to `127.0.0.1`; config validation rejects a non-loopback host without `tokenPath`, so the Coordinator refuses to start.
- With a token, every request must carry it: `Authorization: Bearer <token>`, or a cookie. Opening `/?token=<token>` once sets the cookie (`HttpOnly`, `SameSite=Strict`) and redirects to `/`, so the phone keeps working without the token in the address bar. Comparison is constant-time. Anything else → 401 before anything is rendered.
- Only `GET /` serves the page; other methods → 405, other paths → 404.
- Headers: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- A render exception gives 500 and is logged; a server that cannot bind is logged and the loop runs without it.
- The token file's folder joins the secret paths every session is denied (REQ-001-26).

**Redesign (#60).** The look follows the Owner's mockup in #41 (dark, indigo/green/amber/red by meaning: since #102 amber only for the Owner's move and red only for failures, both softened, with the colour on a status's dot or icon and its text neutral (REQ-003-17), Plus Jakarta Sans, Inter and JetBrains Mono, divided rows, one glass panel, a frosted band around Up next and the Pipeline, which since #100 also holds the footer, fades in only at its top and grows to the bottom of a short page: the body is a flex column and the Overview's `main` and band grow). The page stays server-rendered and complete without JavaScript; the mockup's hash routing became server routes (`/config`, `?repo=`). CSS, an optional script (countdown and reload, copy buttons, WebGL background) and the fonts are files under `src/dashboard/assets/`, served from a fixed list (`assets.ts`) with a content hash in their URL. That replaces the inline CSS and lets the CSP name `'self'` for scripts, styles and fonts, with no `unsafe-*`. The meta refresh stays inside `<noscript>`. The view model gains the Summary, Capacity, the seven columns with a status per issue, the model per session, the repository filter and per-repository counts; the Tick snapshot gains the Worktree count per repository.

**Remote access.** Documented in `docs/setup.md`: keep loopback and use `tailscale serve` (HTTPS, tailnet only) or an SSH tunnel. A token is recommended even on loopback, since `tailscale serve` proxies from localhost and agents run on the same machine.

**React and Tailwind (#72).** The pages are React components (`html.tsx`, `config-html.tsx`, shared parts in `ui.tsx`) rendered with `renderToStaticMarkup`, so the page still works without JavaScript and React escapes every value. No client-side React and no data fetching: the page reloads every poll interval anyway. Styling is Tailwind v4 utilities in the components; `styles.css` keeps the tokens (`@theme`), the fonts, the backdrop and the effects that need pseudo-elements or moving gradients. `styles.ts` builds it with `@tailwindcss/node` and the oxide scanner when `assets.ts` loads (about 0.1 s at start), so there is no build step and no built file in git; it is served as `/assets/dashboard.css` from the fixed list. The script stays the small `assets/dashboard.js`. Not taken from #72's list: Vite (Bun builds and serves), Vitest (`bun test`), Radix/cmdk/sonner and TanStack Query/Virtual (read-only page, tens of rows), Playwright (screenshots use headless Chrome); shadcn/ui's static parts became small local components (`Count`, `Label`, `Heading`), since its default styles would all be overwritten to keep the mockup's look.

## Tasks

- [x] Spec (REQ-003-01 … REQ-003-10)
- [x] Config: optional `dashboard` block, loopback check, secret paths incl. the token folder (REQ-003-07, REQ-003-10)
- [x] Store: session start time, migrated (REQ-003-01)
- [x] Scheduler: queue order and wait reasons in the `Plan` (REQ-003-04)
- [x] Coordinator: publish a `TickSnapshot` at the end of each tick; `maxWorktrees` wait (REQ-003-01, 02, 04, 06)
- [x] View model and HTML (REQ-003-01 … 06, REQ-003-09)
- [x] Server: auth, GET only, headers, isolation (REQ-003-07, 08, 09)
- [x] Wire into `src/index.ts`; docs: README, architecture, setup, glossary, spec index, `config.example.ts`
- [ ] Manual: open it on a phone over Tailscale, screenshots on the PR (needs the Owner's server)

Redesign (#60):

- [x] Spec: amend REQ-003-01, 02, 03, 04, 05, 06, 09; add REQ-003-11 … 14
- [x] Snapshot: Worktree count per repository (REQ-003-05, REQ-003-12)
- [x] View model: Summary, Capacity, seven columns with status, model, filter, Config data (REQ-003-01, 02, 05, 11, 12, 13)
- [x] Markup: Overview and Config page, no inline styles or scripts (REQ-003-01 … 06, 09, 11 … 13)
- [x] Assets: CSS, script, self-hosted fonts with their licences (REQ-003-06, 09, 14)
- [x] Server: `/config`, `?repo=`, `/assets/*` from a fixed list, CSP (REQ-003-05, 09, 13)
- [ ] Manual: screenshots on phone and desktop (no browser in the Implementer's sandbox)

React and Tailwind (#72):

- [x] Spec: REQ-003-19
- [x] Tailwind source and build at start, served from the fixed list (REQ-003-09, REQ-003-19)
- [x] Overview and Config page as React components; tests adapted to the new markup (REQ-003-01 … 16)
- [x] Biome: React rules for the components, Tailwind directives in CSS
- [x] Screenshots before and after from fixture data
