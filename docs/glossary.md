# Glossary

Domain terms used in code, specs and tests. Use these names consistently.

## Agents

| Term        | Definition                                                                                              | Not to be confused with                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Owner       | The single human user. Only their issues, comments, labels and reviews count; only they can approve.    | The Coordinator's bot identity                          |
| Coordinator | The Bun daemon in this repo. Polls GitHub, owns the state machine, starts agents, enforces concurrency. | An agent: the coordinator itself never calls the model. |
| Planner     | Claude Code agent that triages open issues against all open issues/PRs and produces an Assessment.      | Implementer                                             |
| Implementer | Claude Code agent that works on one approved issue (or Bundle) in its own Worktree and opens a PR.      | Planner                                                 |
| Reviewer    | Claude Code agent that reviews an agent PR's head commit in a fresh context and reports findings.       | The old GitHub Actions review workflow                  |
| Role        | One of Planner, Implementer, Reviewer. Each has its own prompt, model and Slot limit.                   |                                                         |
| Result      | JSON file a session must write before its turn may end; validated against the Role's schema.            | The session transcript                                  |

## Workflow

| Term                 | Definition                                                                                                                                                                                                                | Not to be confused with                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Assessment           | Planner's comment on an issue: verdict (proposed / won't fix / needs refinement), approach, Coordination notes.                                                                                                           | Plan approval                                            |
| Coordination note    | Cross-issue relation recorded by the Planner: "do together with #N" (Bundle) or "blocked by #N".                                                                                                                          | GitHub sub-issues                                        |
| Split-off issue      | Issue the Coordinator created from a Planner's proposal while assessing another issue (REQ-001-34). In scope like the Owner's issues; listed under Coordination of its parent.                                            | A GitHub sub-issue; an issue the App created otherwise   |
| Bundle               | Set of issues implemented together in one Worktree and one PR.                                                                                                                                                            | Duplicate issues                                         |
| Sync                 | After any session turn, bringing GitHub in line with its Result (Assessment comment and label, pushed commits and PR body).                                                                                               | The poll                                                 |
| Approval             | Owner's explicit go-ahead on an Assessment; the only trigger for an Implementer run.                                                                                                                                      | A PR review approval                                     |
| Agent PR             | PR the Coordinator opened for an issue or Bundle. It stays a draft until its current head has a Review without findings (REQ-001-31).                                                                                     | A PR opened by a human                                   |
| Orphaned agent PR    | An open Agent PR with no Worktree on record for any of its issues, e.g. after a lost record. It keeps its issues out of planning (REQ-001-40) and is re-attached (REQ-001-41).                                            | A closed PR; a PR opened by a human                      |
| Re-attach            | Rebuilding an orphaned agent PR's Worktree from its remote branch and recording the PR for its issues again, so Reviews and Feedback rounds resume (REQ-001-41).                                                          | Cleanup (REQ-001-14)                                     |
| Feedback round       | Resuming an Implementer session on its existing Worktree to address Review findings, failing checks, merge conflicts or the Owner's comments. Its Result answers each Review finding (REQ-001-35).                        | A fresh Implementer run                                  |
| Review               | The Reviewer's one PR review of a head commit. It lists only findings worth fixing (REQ-002-09); each one starts a Feedback round (REQ-001-11), none makes the PR ready.                                                  | A GitHub approval (the review event is always `COMMENT`) |
| Merge conflict round | A Feedback round started because GitHub reports the PR as not mergeable: the Coordinator fetches the default branch into the Worktree and the Implementer merges it (REQ-001-28). Not counted toward `maxFeedbackRounds`. | A rebase (the push must stay a fast-forward)             |
| Slot                 | One unit of the configured parallelism limit; a running agent occupies a Slot.                                                                                                                                            | Worktree (may exist on disk without holding a Slot)      |
| Worktree             | Checkout dedicated to one issue/Bundle (a local clone, so the agent's git writes stay inside it), kept until its PR is merged or closed.                                                                                  | The main clone                                           |
