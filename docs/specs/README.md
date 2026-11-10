# Specs

One folder per feature: `docs/specs/NNN-name/` with `spec.md` and, for tier 3 work, `plan.md`.

## Index

| Spec                                                   | Area | Status |
| ------------------------------------------------------ | ---- | ------ |
| [001-issue-coordinator](001-issue-coordinator/spec.md) | Core | Draft  |

## Conventions

- **Status:** `Draft` → `Approved` → `Implemented` (or `Deprecated`).
- **Requirement IDs:** `REQ-NNN-XX` (`NNN` = spec number, `XX` = running number).
- **IDs are never reused:** deprecate a requirement instead of deleting it.
- **Tests reference the REQ IDs** at the start of their title.
- **Spec and code change together:** A wrong or missing spec is a spec change, not a bug.
- **No implementation details** in `spec.md`.

## Template: `spec.md`

```markdown
# NNN – <Name>

**Status:** Draft

## Goal

One paragraph: who benefits and why.

## Requirements

### REQ-NNN-01 <title>

- **Given** …
- **When** …
- **Then** …
- **And** … (optional)

## Out of scope

## Assumptions

## Verification

| REQ        | Test          | Result |
| ---------- | ------------- | ------ |
| REQ-NNN-01 | `<test name>` | pass   |
```

## Template: `plan.md`

```markdown
# NNN – <Name>: Plan

## Approach

<How it will be built, key trade-offs.>

## Tasks

- [ ] <task> (REQ-NNN-01)
```
