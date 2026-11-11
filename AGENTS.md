# AGENTS.md

- Purpose: Self-hosted Bun daemon that polls GitHub and runs Claude Code agents to triage, plan, implement and review issues (one worktree per issue), with human approval gates.

## Orientation

Keep the docs up to date when something changes.

| Document                 | Why                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `README.md`              | User facing description. Keep up to date.                                                                         |
| `docs/architecture.md`   | Architecture overview                                                                                             |
| `docs/glossary.md`       | Definitions of domain terms                                                                                       |
| `docs/known-pitfalls.md` | if you encounter problems or pitfalls add them here, either to avoid them in the future or for us to fix later on |
| `docs/specs/README.md`   | Index of feature specs with their status, conventions and template                                                |

## Project

- Stack: TypeScript on Bun, Claude Code CLI (interactive sessions in detached tmux with Remote Control, hooks), GitHub REST API, git worktrees; deployed as a systemd service on Ubuntu.
- Install: `bun install` · Test: `bun test` (real tmux + claude: `bun scripts/smoke-runner.ts`, uses the subscription) · Lint: `bun run lint` (Biome + `tsc --noEmit`; autofix: `bun run lint:fix`) · Run: `bun start` (reads `config.ts`, or `$COORDINATOR_CONFIG`; copy `config.example.ts`) · Setup check: `bun run doctor` · Deployment: `docs/setup.md`

## Principles

> [!NOTE]
> These are no absolutes, decide when it's appropriate to apply them.

- Follow SOLID principles: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion.
- Decide when it's appropriate to apply DRY, YAGNI and KISS.
- spec-first, TDD (red → green → refactor), BDD acceptance criteria. DDD only where the domain warrants it; always use domain terms (`docs/glossary.md`).

## Tiers

0. No behavior change → tests pass.
1. Bug (code violates a REQ) → regression test referencing the REQ, then fix.
2. Small feature or spec gap → `spec.md` first. A wrong or missing spec is a spec change, not a bug.
3. Large or architectural → `spec.md` + `plan.md` (with tasks)

## Specs

`docs/specs/NNN-name/`. IDs are `REQ-NNN-XX`: never reused, deprecated rather than deleted, and referenced in tests. Spec and code change together.

- `spec.md`: Status, Goal, Requirements (Given/When/Then), Out of scope, Assumptions, Verification (REQ | test | result). No implementation details.
- `plan.md`: Approach, Tasks (linked to REQs).

## Definition of Done

- Every REQ in scope has a test that you saw fail, then pass.
- Full test suite and lint run in this session and pass.
- Verification table and spec status updated.
- No unrelated changes.
- If there's UI changes, attach screenshots to the PR to illustrate the changes.
- Summary: tier, REQs touched, results, open issues.

## Git

Stay on the current branch. commit or push only if explicitly asked for.

## Note

For issues and pull requests you create put the following note at the top of the description:

```md
> [!Note]
> 🤖 {Model e.g. Claude Opus 5.5} writing on behalf of {Human}
```
