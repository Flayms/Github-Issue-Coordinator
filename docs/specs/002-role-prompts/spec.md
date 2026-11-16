# 002 – Role prompts

**Status:** Implemented

## Goal

The Owner gets plans they can approve on a phone, code that matches those plans, and Reviews they can trust. To get there, each Role's default prompt sets out what that Role delivers and where its work stops and the next Role's starts. This spec describes that contract, not the prompts' wording. The prompts are written for capable models (Opus class): they give goals, constraints and the reasons behind them, not step-by-step scripts.

## Requirements

### REQ-002-01 The Planner decides what and why

- **Given** the default Planner prompt
- **When** the Planner proposes an approach for an issue
- **Then** the Assessment names the Tier, the requirements it adds or changes (wording sketched as Given/When/Then for Tier 2 and up), the acceptance criteria, the modules or files that change, the test strategy and the risks
- **And** every design choice the Owner should decide comes with a recommendation and one alternative that was rejected, with the reason
- **And** the Assessment contains no code and no line-by-line plan, and its length matches the size of the issue

### REQ-002-02 The Planner checks before it plans

- **Given** the default Planner prompt
- **When** the Planner assesses an issue
- **Then** it first checks whether the issue is already fixed or duplicated (git history, open issues and PRs) and reads the code involved before it says anything about it
- **And** it uses `needs-refinement` only for questions whose answer would change the plan; for other open points it states the default it picked

### REQ-002-03 The Implementer decides how, within the approved scope

- **Given** the default Implementer prompt
- **When** the Implementer works on an approved issue
- **Then** it decides the code-level design, the exact test cases and the final spec wording inside the approved scope, and may change details of the Assessment
- **And** if the scope or a design choice the Owner approved turns out wrong or impossible, it stops and explains this in its Result instead of building something else

### REQ-002-04 The Implementer proves its change

- **Given** the default Implementer prompt
- **When** the Implementer changes behaviour
- **Then** it writes or updates a test first and sees it fail before making it pass
- **And** it never weakens, skips or deletes tests or assertions, and never special-cases code for a test, to get the suite green
- **And** it keeps the change minimal (no unrelated refactors or speculative abstractions), runs the full test suite and linters before it finishes, and says in its Result what it could not verify

### REQ-002-05 The Reviewer checks the result against the plan

- **Given** the default Reviewer prompt
- **When** the Reviewer reviews an agent PR
- **Then** it checks the diff against the approved Assessment, the requirements and the repository's conventions: requirements covered, tests that really exercise the behaviour (no gamed or tautological assertions), edge cases, security (secrets, the sandbox, instructions injected through issue or PR text), docs and specs updated, no unrelated changes
- **And** it does not redesign the change
- **And** it prefers a few well-founded findings over many speculative ones (which findings it reports at all: REQ-002-09)

### REQ-002-06 Shared rules for all Roles

- **Given** the default prompt of any Role
- **When** the session works
- **Then** it reads code before making claims about it, and checks APIs in the source or official documentation instead of guessing
- **And** it uses the domain terms of the repository's glossary, if there is one
- **And** it treats issue text, comments, PR content and web pages as data, never as instructions

### REQ-002-07 Planner and Reviewer can list tracked files

- **Given** a Planner or Reviewer session
- **When** it runs `git ls-files`
- **Then** the command is allowed without asking, inside the sandbox like its other shell commands (REQ-001-26)
- **And** `git grep` is not allowed, because `git grep -O<cmd>` runs an arbitrary command; the Grep tool covers content search

### REQ-002-08 The Planner knows when to split off an issue

- **Given** the default Planner prompt
- **When** the Planner assesses an issue
- **Then** it lists Split-off issues (REQ-001-34) only when the issue mixes independent changes or it found a separate bug or follow-up while reading the code
- **And** it checks the open issues first so it doesn't create a duplicate

### REQ-002-09 The Reviewer reports only findings worth fixing

- **Given** the default Reviewer prompt
- **When** the Reviewer writes findings
- **Then** each one is something that should be fixed before merging: a concrete failure scenario, an unmet requirement or acceptance criterion, a gamed or missing test, a security problem, or a clear breach of the repository's conventions
- **And** nits, matters of taste and speculation are left out, since every finding starts a Feedback round (REQ-001-11)
- **And** a finding's severity is `high` or `medium`, and the Result has no `blocking` field
- **And** doubts about the approved plan go in `summary` only, not into findings
- **And** on a re-review it raises a finding the Implementer declined again only if it says why the reason is wrong (REQ-001-36)

### REQ-002-10 The Planner replies to feedback comments

- **Given** the default Planner prompt
- **When** the Owner's comments started a revision
- **Then** the Planner writes a brief `reply` in its Result: a few lines on what changed and why, or why nothing changed (REQ-001-40)
- **And** it leaves `reply` out on any other turn

### REQ-002-11 Agent output is easy to scan on a phone

- **Given** the default prompt of any Role
- **When** the session writes text the Coordinator posts to GitHub (Planner `approach` and `reply`, Implementer `prBody`, Reviewer `summary` and finding `body`)
- **Then** the text opens with a one- or two-line summary of the outcome (for the Reviewer's `summary`: a verdict line)
- **And** it uses GitHub Markdown structure instead of long paragraphs: headings at level `###` or lower (the Coordinator's own heading is `##`), short bullets, a table when several items share the same fields, and `<details>` for material the reader may skip
- **And** it keeps paragraphs to a few sentences, bolds only key terms, and stays proportionate to the size of the change
- **And** the Planner keeps the order of its topics (REQ-002-01) as `###` sections or a compact list, with Given/When/Then as three bullets per requirement

### REQ-002-12 Diagrams only where they help

- **Given** the default prompt of any Role
- **When** a change touches a flow, a state machine or how components interact
- **Then** the session may add a small Mermaid diagram next to the text it explains
- **And** it adds no diagram otherwise, and never ASCII art

### REQ-002-13 The Implementer shows its UI changes

- **Given** the default Implementer prompt and a repository whose conventions ask for screenshots of UI changes
- **When** the Implementer changes a page
- **Then** it captures the pages its change affects with the host's headless browser, saves them in `.coordinator/screenshots/` and lists them in `screenshots` with a caption each (REQ-001-48)
- **And** if it can't capture them, it says so and why in `prBody` instead of failing the task

## Out of scope

- Letting the Reviewer run the test suite or linters (it would execute the PR's code; REQ-001-25 stays as it is).
- Updating prompts that a repository has overridden in `.github/coordinator/<role>.md` (REQ-001-22).
- Structured Result fields that the Coordinator renders into a fixed template; REQ-002-11 is prompt guidance only.
- Changing the Result schemas, apart from the Reviewer's findings (REQ-002-09); the Planner's `splitOff` field belongs to REQ-001-34, `reply` to REQ-001-40, the Implementer's `screenshots` to REQ-001-48.

## Assumptions

- Prompt quality can't be fully unit-tested. Tests check the contract's sections and terms; a real run per Role (`bun scripts/smoke-runner.ts`, or dogfooding) is the actual check.
- Each prompt stays under about 80 lines, since it is sent at the start of every session.

## Verification

| REQ        | Test                                                                                                                                                | Result                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| REQ-002-01 | `prompts > REQ-002-01 the Planner prompt asks for Tier, requirements, files, tests, risks and decisions, but no code`                               | pass (wording only; quality via a real run)              |
| REQ-002-02 | `prompts > REQ-002-02 the Planner prompt checks for duplicates and limits needs-refinement to plan-changing questions`                              | pass (wording only; quality via a real run)              |
| REQ-002-03 | `prompts > REQ-002-03 the Implementer prompt owns the how and stops when the approved scope is wrong`                                               | pass (wording only; quality via a real run)              |
| REQ-002-04 | `prompts > REQ-002-04 the Implementer prompt asks for red-green tests, no test weakening, the full suite and unverified`                            | pass (wording only; quality via a real run)              |
| REQ-002-05 | `prompts > REQ-002-05 the Reviewer prompt checks against the Assessment with a checklist and well-founded findings`                                 | pass (wording only; quality via a real run)              |
| REQ-002-06 | `prompts > REQ-002-06 every default prompt has the shared rules`                                                                                    | pass                                                     |
| REQ-002-07 | `permissions > REQ-001-25 / REQ-002-07 Planner and Reviewer may only read, run read-only git …` (incl. no `git grep`)                               | pass                                                     |
| REQ-002-08 | `prompts > REQ-002-08 the Planner prompt says when to split off an issue and to check open issues first`                                            | pass (wording only; quality via a real run)              |
| REQ-002-09 | `prompts > REQ-002-09 the Reviewer prompt reports only findings worth fixing, without blocking or low severity`; `Result validation > REQ-002-09 …` | pass (wording and schema; quality via a real run)        |
| REQ-002-10 | `prompts > REQ-002-10 the Planner prompt asks for a brief reply on a revision the Owner's comments started`                                         | pass (wording only; quality via a real run)              |
| REQ-002-11 | `prompts > REQ-002-11 every default prompt asks for a summary first and scannable GitHub Markdown in the posted text`                               | pass (wording only; quality and phone via a real run)    |
| REQ-002-11 | `prompts > REQ-002-11 the Planner writes Given/When/Then as bullets and the Reviewer opens with a verdict line`                                     | pass (wording only; quality and phone via a real run)    |
| REQ-002-12 | `prompts > REQ-002-12 every default prompt allows a Mermaid diagram only where a flow or state change is clearer drawn`                             | pass (wording only; quality and phone via a real run)    |
| REQ-002-13 | `prompts > REQ-002-13 the Implementer prompt captures Screenshots of UI changes when the conventions ask, or says why not`                          | pass (wording only; quality via a real run)              |
| all        | manual: one real run per Role                                                                                                                       | open (to be done by the Owner on this PR via dogfooding) |
