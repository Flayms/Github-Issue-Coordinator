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

| Term              | Definition                                                                                                                               | Not to be confused with                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Assessment        | Planner's comment on an issue: verdict (proposed / won't fix / needs refinement), approach, Coordination notes.                          | Plan approval                                       |
| Coordination note | Cross-issue relation recorded by the Planner: "do together with #N" (Bundle) or "blocked by #N".                                         | GitHub sub-issues                                   |
| Bundle            | Set of issues implemented together in one Worktree and one PR.                                                                           | Duplicate issues                                    |
| Sync              | After any session turn, bringing GitHub in line with its Result (Assessment comment and label, pushed commits and PR body).              | The poll                                            |
| Approval          | Owner's explicit go-ahead on an Assessment; the only trigger for an Implementer run.                                                     | A PR review approval                                |
| Feedback round    | Resuming an Implementer session on its existing Worktree to address review findings or owner comments.                                   | A fresh Implementer run                             |
| Merge conflict round | A Feedback round started because GitHub reports the PR as not mergeable: the Coordinator fetches the default branch into the Worktree and the Implementer merges it (REQ-001-28). | A rebase (the push must stay a fast-forward) |
| Slot              | One unit of the configured parallelism limit; a running agent occupies a Slot.                                                           | Worktree (may exist on disk without holding a Slot) |
| Worktree          | Checkout dedicated to one issue/Bundle (a local clone, so the agent's git writes stay inside it), kept until its PR is merged or closed. | The main clone                                      |
