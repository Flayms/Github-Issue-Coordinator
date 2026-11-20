# How it works

The full workflow behind the [README](../README.md)'s short version. Terms in capitals are defined in the [glossary](glossary.md).

- [1. You open an issue](#1-you-open-an-issue)
- [2. The Planner assesses it](#2-the-planner-assesses-it)
- [3. You approve](#3-you-approve)
- [4. The Implementer works on it](#4-the-implementer-works-on-it)
- [5. The Reviewer reviews the PR](#5-the-reviewer-reviews-the-pr)
- [6. You merge](#6-you-merge)
- [Auto-merge](#auto-merge)
- [The VM and GitHub access](#the-vm-and-github-access)
- [Accounts](#accounts)
- [Dashboard](#dashboard)
- [Role prompts](#role-prompts)

## 1. You open an issue

- Only issues you, the Owner, authored are considered, plus Split-off issues the Planner proposed ([step 2](#split-off-issues)).
- Comments, labels and reviews by anyone else are ignored.

## 2. The Planner assesses it

The Planner posts an **Assessment** comment: the proposed approach, questions, and Coordination notes ("do together with #N", "blocked by #N"). The issue gets one of three labels: `agent:proposed`, `agent:needs-refinement` or `agent:wontfix-proposed`.

### Revising the plan

- **Comment with feedback** to revise it: the Assessment is edited in place, and the Planner answers below your comment with a short **Reply** saying what changed and why.
- **Edit the issue description** instead to have it planned from scratch, without the old plan.
- You can do either as often as you like; each revised Assessment can change the verdict to any of the three proposal labels.

### Linked history

If the issue or your comment links to another issue or PR of the same repository (`#N` or its URL), the Planner also gets its recent history: state, labels, timeline events, Reviews and last comments. Up to 5 linked items per issue.

### Split-off issues

If an issue mixes independent changes, or the Planner finds a separate bug, it can split off new issues:

- The Coordinator creates them (at most 5 per Assessment, never twice), links them back and lists them under Coordination.
- They are planned like your own issues, and still need your approval.

### Mockups

When you ask to see options or how something will look, the Planner renders Mockups and the Assessment shows them, so you choose before anything is built.

## 3. You approve

- Comment `/approve [notes]` or add the `agent:approved` label. The notes go to the Implementer.
- Nothing said inside a session counts as approval.

## 4. The Implementer works on it

- It works in its own **Worktree** and branch (`agent/<issue>-<slug>`). Issues of a **Bundle** share one.
- A Bundle waits while you are still discussing one of its issues (an unanswered comment, or a plan being revised).
- The Coordinator pushes and opens a **draft** PR that closes the issues, so it can't be merged before its Review.
- Screenshots of UI changes the Implementer captured show in the PR body. They are kept on the branch `agent-screenshots`, never in the PR's commits.

## 5. The Reviewer reviews the PR

The Reviewer reviews the PR as soon as it is pushed, alongside its checks, unless it has merge conflicts. A **Review** is one review with inline comments, never an approval. It reports only findings worth fixing (no nits or matters of taste).

### Without findings

The PR is labelled `agent:reviewed`. Once its checks pass, it is marked ready for review and assigned to you, so it shows under your assigned PRs on GitHub.

### Feedback rounds

- Every finding and failing checks go back to the Implementer, in one **Feedback round** when they concern the same commit.
- That happens up to `maxFeedbackRounds` times; then the PR is labelled `agent:failed`.
- The Implementer answers each finding on the PR (`fixed`, or `declined` with a reason), and the next Review sees those answers.

### Merge conflicts

Merge conflicts go back to the Implementer too, but don't count toward `maxFeedbackRounds`. The Coordinator fetches the default branch and the Implementer merges it, also after a PR was already reviewed.

### When a round ends without a new commit

If an automatic round ends without a new commit (findings declined, checks still failing, conflicts still there), the Coordinator says why in a PR comment and the PR waits for you. You can:

- comment `/agent <text>` to have it fixed anyway. On a conflicting PR, also a failed one, this fetches the default branch first and asks for the merge;
- mark it ready yourself;
- or merge it yourself.

### New commits after a Review

Any new commit pushed after a Review turns the PR back into a draft until that commit is reviewed, and an `agent:reviewed` PR goes back to `agent:pr-open`. A failed PR stays a draft. The README's [Labels](../README.md#labels) section shows the whole lifecycle.

## 6. You merge

- Merge once the PR has left draft, or click "Ready for review" yourself to override.
- The Worktree and sessions are cleaned up.
- With [auto-merge](#auto-merge) on, the Coordinator merges it for you instead.
- Merging or closing the PR clears the issue's agent labels. An issue whose PR was closed unmerged is open again without a label and gets a new Assessment.

## Auto-merge

Optional. Every Review names a **Risk tier** (`low`, `medium` or `high`) with a one-line reason, shown in the Review. `autoMerge` decides what the Coordinator merges itself, at the moment the PR would otherwise leave draft for you (no findings, checks passed):

| `autoMerge`           | Merges                                     |
| --------------------- | ------------------------------------------ |
| `evaluated` (default) | PRs rated `low`; the rest is left to you   |
| `off`                 | nothing: set it to merge every PR yourself |
| `all`                 | every such PR                              |

- `evaluated` applies when nothing sets `autoMerge`, so an existing `config.ts` without it starts merging `low` PRs after an update: set `autoMerge: "off"` to keep merging by hand.
- Set it globally or per repository, in `config.ts` or on the dashboard's Config page. `risk-evaluated`, its old name, still works, and `bun run doctor` warns about it.
- **No gate is skipped:** PRs with findings, declined findings, failing checks, conflicts or your `/agent` comment waiting are never merged.
- A PR that changes `.github/workflows/` is always rated `high`.
- The merge is a squash pinned to the reviewed commit; the Coordinator comments on the PR why it merged.
- If GitHub refuses (e.g. a ruleset requires an approval), the PR is ready for you as usual, with the reason in a comment.

## The VM and GitHub access

- The Coordinator runs on a **VM of its own**. Agents run with their Harness's permission prompts skipped and no sandbox: on that VM they may do whatever they want.
- The only boundary is GitHub: the Coordinator and the agents share one fine-grained **PAT**, logged in with `gh`, limited to the repositories you choose ([spec 005](specs/005-vm-runtime/spec.md)).
- Agents read GitHub with `gh` to look up context their prompt leaves out. Posting, labelling, pushing and opening PRs is left to the Coordinator.

## Accounts

Optional: several subscriptions, of one or more Harnesses.

- List them as `accounts` in the config; sessions run on the first one of their model's Harness ([Harnesses](harnesses.md)).
- Claude Code, Codex CLI, Antigravity CLI, Copilot CLI and OpenCode: a Role's model decides which runs it (`opus` on Claude Code, `gpt-6.2-sol` on Codex CLI, `gemini-4-neon` on Antigravity CLI, `copilot:claude-sonnet-5.5` on Copilot CLI, `opencode:opencode/big-pickle` on OpenCode); a resumed session stays on the Harness it started on. Codex, Antigravity, Copilot and OpenCode sessions have no Remote Control link, no Now line and no Usage quota meters yet, Antigravity and OpenCode have one Account each, and Copilot's and OpenCode's Accounts pause for the default interval on a usage limit ([feature matrix](harnesses.md#feature-matrix)).
- When it hits its usage limit, it is paused until the limit resets (30 minutes when the reset time can't be read), and work, including the cut-off session, goes on with the next one.
- New work waits only while every Account of its Harness is paused.

Setup: [docs/setup.md](setup.md#3-configure).

## Dashboard

On by default ([setup](setup.md#4-dashboard), [spec 003](specs/003-dashboard/spec.md)). A mobile-friendly page with three views.

### Overview

- **Your move** leads: how many things need you, listed in groups right under it (PRs to merge, failed issues, questions to answer, plans to approve, issues to close). A long list shows 5 and "Show N more".
- **Next to it:** what is running and the capacity (running and live sessions, Slots, Worktrees).
- **Activity**, one timeline:
  - Recent: what the Coordinator did (PRs opened, Reviews, failures with their reason);
  - Now: the agent sessions (running ones first, with their model and Remote Control names; idle ones say when they close). Each card has a Now line, what the agent is doing, from the tail of its transcript, e.g. `TOOL Bash · bun test · 12 s ago` (an idle one shows _Turn ended_ and its last text), and an **Open chat** link to the session's Remote Control page, where you read the whole chat and write to the agent. The dashboard itself stays read-only;
  - Next: what runs next and why each item waits.
- **Pipeline:** every issue's phase and PR (checks, mergeability, Feedback rounds), saying what each one needs, filterable by repository.

### Config and Timings

- The **Config page** shows the settings without secrets. Once you are signed in, it lets you change limits, poll interval, the auto-merge mode, each Role's model and effort and its Extra instructions (also per repository); a model is picked from a list of aliases ("Opus (latest)") and pinned versions ("Opus 5.5"). They apply from the next tick on, without a restart, and are kept over `config.ts` in the state dir.
- The **Timings page** shows one issue's Planning, Building and Review on one time axis, each step a glass capsule like the Capacity meters: indigo liquid while an agent works, darker for checks, amber for your time (only with "Include your time"; otherwise it is cut out of the axis) and empty glass while waiting in the queue. Tiles above it give the total, the agents' and the queue's share and the rounds. On a phone each phase has its own scale.

### Behaviour and access

- It refreshes in place every poll interval, keeping the scroll position and what you opened. Without JavaScript it reloads instead.
- It loads nothing from other origins (its fonts are self-hosted).
- It changes nothing on GitHub. `dashboard: false` turns it off.
- It listens on loopback and is meant to be reached over Tailscale or an SSH tunnel.
- It lets only you in with "Sign in with GitHub" (a GitHub OAuth App); a token still works for scripts.

## Role prompts

Each Role's default prompt lives in [`prompts/`](../prompts/) ([spec 002](specs/002-role-prompts/spec.md)):

- the **Planner** decides _what_ and _why_: Tier, requirements sketched as Given/When/Then, files, tests, risks, decisions with a recommendation;
- the **Implementer** decides _how_ within that scope, and stops if it turns out wrong;
- the **Reviewer** checks the PR against the approved Assessment without redesigning it.

### Customising prompts

Three ways, from the safest to the riskiest:

| Way                                  | Where                                                                                | What it does                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Extra instructions** (recommended) | Config page, or `instructions` in `config.ts`; per Role, globally and per repository | Added after the Role prompt under "Additional instructions from the Owner" (global first, then the repository's), for sessions started from then on. At most 4,000 characters each. The default prompt keeps its updates. |
| `CLAUDE.md` / `AGENTS.md`            | The managed repository                                                               | Every agent reads them, as Claude Code does in any session. Versioned with the repository.                                                                                                                                |
| `.github/coordinator/<role>.md`      | The managed repository                                                               | **Replaces** the Role's default prompt. It no longer gets updates to `prompts/` and can drop rules such as "don't post on GitHub", so compare it with `prompts/` after upgrading. Extra instructions still follow it.     |

None of them changes the Result instruction, which the Coordinator appends last and validates, or the Coordinator's own gates (approval, labels, merges), which are enforced in code, not in the prompt.
