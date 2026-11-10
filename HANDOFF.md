# Handoff: planning session → development on the server

> Temporary file. It carries the context of the first planning session (held on the Owner's Windows PC) into a new Claude Code session on the server. Delete it once its content has been absorbed into the docs or is no longer needed.

## Read first

1. `AGENTS.md`: conventions, tiers, Definition of Done. Follow it.
2. `docs/specs/001-issue-coordinator/spec.md`: 22 requirements (REQ-001-01 … 22). This is the source of truth for behavior.
3. `docs/specs/001-issue-coordinator/plan.md`: approach, config sketch, tasks T0–T14. T0 is done.
4. `docs/known-pitfalls.md`: findings from the T0 spike.
5. `docs/glossary.md`: use these terms in code and tests.
6. `spikes/t0/`: throwaway spike code; useful reference for the session runner (T6).

## About the Owner

- Single user. They have a **Claude Pro subscription, not API access**, so everything must run on the subscription login.
- On the server, they **do not want to run `claude` commands manually**. Sessions started by the Coordinator must simply show up in the Claude app on their phone, where they follow them live and chat. tmux was only ever a way to keep `claude rc` alive on their laptop, not a workflow they want to use.
- All glue code in **TypeScript on Bun**, for simplicity and fast iteration.
- They commit and push themselves. Don't commit or push unless asked.

## Decisions made, and why

| Decision                                                                                                                                          | Why                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Polling** (reconcile loop, ETag requests), no webhooks for now                                                                                  | No inbound port needed. State is derived from labels, so the Coordinator survives restarts. Webhooks may be added later only as a trigger for a sooner poll. The server may become reachable later.                                                                                              |
| Several repos, **public and private**, **only issues authored by the Owner**                                                                      | Prompt-injection risk on public repos. Comments, labels and reviews from anyone else are ignored.                                                                                                                                                                                                |
| **Approval only by the Owner on GitHub**: `agent:approved` label or `/approve [notes]` comment, checked by numeric user id and the timeline actor | The Owner asked for approval that only they can trigger. Chat inside a session never counts as approval.                                                                                                                                                                                         |
| **GitHub App** as the Coordinator's identity (not a fine-grained PAT)                                                                             | Separate bot identity, so the Owner's own approvals are distinguishable from the agent's comments. Minimal permissions.                                                                                                                                                                          |
| **Ruleset on each repo's default branch, bypass for the Owner only**                                                                              | `Contents: write` alone cannot prevent merges or pushes to main. The Owner agreed to add the rulesets.                                                                                                                                                                                           |
| **Agents get no GitHub write credentials**; the Coordinator posts, pushes, opens PRs and posts reviews                                            | Least privilege; limits the damage from prompt injection.                                                                                                                                                                                                                                        |
| **`claude` CLI, not the Agent SDK**                                                                                                               | The Agent SDK docs say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…". The Owner has no API key.             |
| **Interactive `claude --remote-control <name> "<prompt>"` in detached tmux windows**, with hooks through `--settings` (not headless `-p`)         | Only interactive sessions register with Remote Control. Headless runs can't be followed or chatted with from the phone. The Coordinator owns tmux; the Owner never touches it.                                                                                                                   |
| **No `claude setup-token`**; the server user logs in once with `/login`                                                                           | Remote Control does not support `setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`.                                                                                                                                                                                                                       |
| **Reviewer built into the Coordinator** (third Role), replacing the existing GitHub Actions review workflow in managed repos                      | The Owner wants control over the reviewer's prompt and model. Reviews are always posted as `COMMENT`, never `APPROVE`.                                                                                                                                                                           |
| **Model, effort and prompt per Role** (Planner, Implementer, Reviewer), with per-repo overrides                                                   | The Owner asked for each to be settable independently.                                                                                                                                                                                                                                           |
| Planner: **one batch session per poll** over all new issues                                                                                       | Cheaper, and cross-issue coordination ("do together with #15", "blocked by #18") needs the global view.                                                                                                                                                                                          |
| Defaults the Owner accepted                                                                                                                       | Poll every 60s; 1 planner / 1 implementer / 1 reviewer, 1 running in total; `maxFeedbackRounds: 2`; the Implementer also fixes failing CI (counted in the rounds); dedicated `agent` Linux user + Claude Code's sandbox; Biome + `tsc --noEmit` for lint; GitHub's own notifications are enough. |

## Server facts (from T0, 2026-11-10)

- Ubuntu, **4 GB RAM** (hostname `anton-ubuntu-4gb-…`). Repo cloned at `~/repos/Github-Issue-Coordinator`.
- Claude Code 2.1.322, tmux 3.6, git 2.53, Bun installed. Logged in with a Pro subscription as user `anton`.
- `claude auth status` shows `loginExpiresAt` ≈ 2 weeks out; it's unknown whether this refreshes itself (see known pitfalls).
- The spike ran as `anton`. The plan says the Coordinator runs as a dedicated `agent` user, which then needs its own `/login`. Confirm with the Owner during T14 whether they really want a separate user.

## Open points

- **Decided (session 2):** session lifetime rules are in REQ-001-02/03/18/20/23/24. `maxLiveSessions` is 2, counting running and idle sessions, because of the 4 GB of RAM (each idle session is a live `claude` process).
- **Unanswered:** should there be a daily cap on new issues assessed by the Planner, to protect the shared Pro quota?
- **Out of scope for now:** the Reviewer also reviewing PRs the Owner opens (possible later as a per-repo opt-in).
- **T0 (e):** the usage-limit signal format is unknown. The runner must log unknown `Stop`/`Notification` payloads so it can be pinned down the first time it happens.
- **Untested:** pre-trusting folders via `~/.claude.json` (`spikes/t0/t0.ts --pretrust`). Answering the trust dialog via `tmux send-keys Down`, then `Enter`, is verified.
- **Unknown:** the bot login / workflow name of the existing GitHub Actions reviewer, needed for the "disable it" step in T14.

## Next step

Start **T1** (project tooling): `bun init`, Biome, `tsc --noEmit`, `bun test`. Then replace `Lint: n/a · Run: n/a` in `AGENTS.md` with the real commands. Continue with T2 onward in plan order, following the tiers and the Definition of Done in `AGENTS.md`.
