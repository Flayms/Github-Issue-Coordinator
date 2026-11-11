/**
 * Local state the labels can't carry: sessions and per-issue bookkeeping (plan.md "Store").
 * Together with the labels it is enough to rebuild state after a restart (REQ-001-16).
 */
import { Database } from "bun:sqlite";
import type { Role } from "./config.ts";

export type SessionState = "running" | "idle" | "closed";

export interface SessionRecord {
  /** Store id; also names the tmux window. */
  id: number;
  repo: string;
  role: Role;
  /** `batch`: a Planner pass over several issues (REQ-001-02); `issue`: one issue or Bundle. */
  kind: "batch" | "issue";
  issues: number[];
  /** Claude Code's session id, reported by the `SessionStart` hook; needed to resume. */
  claudeSessionId: string | null;
  state: SessionState;
  resumeAttempts: number;
  lastActivityAt: string;
  /** Last time the Owner sent the session a message (REQ-001-19, REQ-001-20). */
  ownerMessagedAt: string | null;
  /** The next prompt is the Coordinator's own, not the Owner's. */
  coordinatorPromptPending: boolean;
  /** Blocked stops in a row because the Result was missing or invalid (REQ-001-21). */
  resultFailures: number;
  /** A turn ended and its Result still has to be synced to GitHub (REQ-001-19). */
  needsSync: boolean;
  /** The turn ended on the subscription usage limit (REQ-001-17). */
  usageLimited: boolean;
}

/** A Worktree on record: its issues (a Bundle shares one), PR and last reviewed head. */
export interface WorktreeRecord {
  worktreePath: string;
  issues: number[];
  prNumber: number | null;
  reviewedHeadSha: string | null;
}

export interface IssueRecord {
  repo: string;
  number: number;
  /** Comments up to this id have been handled. */
  lastHandledCommentId: number;
  assessmentCommentId: number | null;
  /** Automatic Feedback rounds on the issue's PR (REQ-001-11). */
  feedbackRounds: number;
  reviewedHeadSha: string | null;
  prNumber: number | null;
  worktreePath: string | null;
  /** The latest Assessment as JSON (one Planner Result entry); the source of Coordination notes. */
  assessment: string | null;
  /** Hash of the issue body the Planner last saw, to notice edits (REQ-001-03). */
  bodyHash: string | null;
  /** When the Owner approved the issue (REQ-001-04); also the Implementer queue order (REQ-001-08). */
  approvedAt: string | null;
  /** Notes from `/approve [notes]`, passed to the Implementer. */
  approvalNotes: string | null;
  /** Blocking Review findings (or other feedback) waiting for a Feedback round (REQ-001-11). */
  pendingFeedback: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  issues TEXT NOT NULL,
  claude_session_id TEXT,
  state TEXT NOT NULL,
  resume_attempts INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL,
  owner_messaged_at TEXT,
  coordinator_prompt_pending INTEGER NOT NULL DEFAULT 0,
  result_failures INTEGER NOT NULL DEFAULT 0,
  needs_sync INTEGER NOT NULL DEFAULT 0,
  usage_limited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS issues (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  last_handled_comment_id INTEGER NOT NULL DEFAULT 0,
  assessment_comment_id INTEGER,
  feedback_rounds INTEGER NOT NULL DEFAULT 0,
  reviewed_head_sha TEXT,
  pr_number INTEGER,
  worktree_path TEXT,
  assessment TEXT,
  body_hash TEXT,
  approved_at TEXT,
  approval_notes TEXT,
  pending_feedback TEXT,
  PRIMARY KEY (repo, number)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface SessionRow {
  id: number;
  repo: string;
  role: Role;
  kind: "batch" | "issue";
  issues: string;
  claude_session_id: string | null;
  state: SessionState;
  resume_attempts: number;
  last_activity_at: string;
  owner_messaged_at: string | null;
  coordinator_prompt_pending: number;
  result_failures: number;
  needs_sync: number;
  usage_limited: number;
}

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  repo: r.repo,
  role: r.role,
  kind: r.kind,
  issues: JSON.parse(r.issues),
  claudeSessionId: r.claude_session_id,
  state: r.state,
  resumeAttempts: r.resume_attempts,
  lastActivityAt: r.last_activity_at,
  ownerMessagedAt: r.owner_messaged_at,
  coordinatorPromptPending: r.coordinator_prompt_pending === 1,
  resultFailures: r.result_failures,
  needsSync: r.needs_sync === 1,
  usageLimited: r.usage_limited === 1,
});

const ISSUE_COLUMNS = {
  lastHandledCommentId: "last_handled_comment_id",
  assessmentCommentId: "assessment_comment_id",
  feedbackRounds: "feedback_rounds",
  reviewedHeadSha: "reviewed_head_sha",
  prNumber: "pr_number",
  worktreePath: "worktree_path",
  assessment: "assessment",
  bodyHash: "body_hash",
  approvedAt: "approved_at",
  approvalNotes: "approval_notes",
  pendingFeedback: "pending_feedback",
} as const satisfies Record<Exclude<keyof IssueRecord, "repo" | "number">, string>;

export class Store {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new Database(path, { create: true, strict: true });
    // Hook processes write concurrently with the Coordinator.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  clock(): Date {
    return this.now();
  }

  close(): void {
    this.db.close();
  }

  createSession(s: Pick<SessionRecord, "repo" | "role" | "kind" | "issues">): number {
    const row = this.db
      .query<{ id: number }, Record<string, string>>(
        `INSERT INTO sessions (repo, role, kind, issues, state, last_activity_at)
         VALUES ($repo, $role, $kind, $issues, 'running', $at) RETURNING id`,
      )
      .get({ repo: s.repo, role: s.role, kind: s.kind, issues: JSON.stringify(s.issues), at: this.stamp() });
    if (!row) throw new Error("failed to create session");
    return row.id;
  }

  session(id: number): SessionRecord | undefined {
    const row = this.db.query<SessionRow, [number]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : undefined;
  }

  /** Open (running or idle) sessions of a repository. */
  sessions(repo: string): SessionRecord[] {
    return this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE repo = ? AND state != 'closed' ORDER BY id")
      .all(repo)
      .map(toSession);
  }

  /** The most recent session of a Role that covered the issue, open or closed. */
  latestSession(repo: string, issue: number, role: Role): SessionRecord | undefined {
    const row = this.db
      .query<SessionRow, [string, string, number]>(
        `SELECT s.* FROM sessions s, json_each(s.issues) i
         WHERE s.repo = ? AND s.role = ? AND i.value = ? ORDER BY s.id DESC LIMIT 1`,
      )
      .get(repo, role, issue);
    return row ? toSession(row) : undefined;
  }

  setClaudeSessionId(id: number, claudeSessionId: string): void {
    this.db.query("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(claudeSessionId, id);
  }

  setState(id: number, state: SessionState): void {
    this.db.query("UPDATE sessions SET state = ?, last_activity_at = ? WHERE id = ?").run(state, this.stamp(), id);
  }

  /** Applies hook-side changes in one statement; `touch` also updates the last activity. */
  patchSession(
    id: number,
    patch: Partial<
      Pick<
        SessionRecord,
        "state" | "ownerMessagedAt" | "coordinatorPromptPending" | "resultFailures" | "needsSync" | "usageLimited"
      >
    >,
  ): void {
    const cols: Record<string, string> = {
      state: "state",
      ownerMessagedAt: "owner_messaged_at",
      coordinatorPromptPending: "coordinator_prompt_pending",
      resultFailures: "result_failures",
      needsSync: "needs_sync",
      usageLimited: "usage_limited",
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    const sets = [...entries.map(([k]) => `${cols[k]} = ?`), "last_activity_at = ?"].join(", ");
    const values = entries.map(([, v]) => (typeof v === "boolean" ? Number(v) : v)) as (string | number | null)[];
    this.db.query(`UPDATE sessions SET ${sets} WHERE id = ?`).run(...values, this.stamp(), id);
  }

  recordResume(id: number): void {
    this.db.query("UPDATE sessions SET resume_attempts = resume_attempts + 1 WHERE id = ?").run(id);
  }

  issue(repo: string, number: number): IssueRecord {
    const row = this.db
      .query<Record<string, unknown>, [string, number]>("SELECT * FROM issues WHERE repo = ? AND number = ?")
      .get(repo, number);
    const rec: IssueRecord = {
      repo,
      number,
      lastHandledCommentId: 0,
      assessmentCommentId: null,
      feedbackRounds: 0,
      reviewedHeadSha: null,
      prNumber: null,
      worktreePath: null,
      assessment: null,
      bodyHash: null,
      approvedAt: null,
      approvalNotes: null,
      pendingFeedback: null,
    };
    if (row) {
      for (const [key, col] of Object.entries(ISSUE_COLUMNS))
        (rec as unknown as Record<string, unknown>)[key] = row[col];
    }
    return rec;
  }

  updateIssue(repo: string, number: number, patch: Partial<Omit<IssueRecord, "repo" | "number">>): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    this.db.query("INSERT OR IGNORE INTO issues (repo, number) VALUES (?, ?)").run(repo, number);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${ISSUE_COLUMNS[k as keyof typeof ISSUE_COLUMNS]} = ?`).join(", ");
    this.db
      .query(`UPDATE issues SET ${sets} WHERE repo = ? AND number = ?`)
      .run(...(entries.map(([, v]) => v) as (string | number | null)[]), repo, number);
  }

  /** Worktrees on record (REQ-001-14), grouped by path, with their issues and PR. */
  worktrees(repo: string): WorktreeRecord[] {
    const rows = this.db
      .query<
        { number: number; worktree_path: string; pr_number: number | null; reviewed_head_sha: string | null },
        [string]
      >(
        "SELECT number, worktree_path, pr_number, reviewed_head_sha FROM issues WHERE repo = ? AND worktree_path IS NOT NULL ORDER BY number",
      )
      .all(repo);
    const byPath = new Map<string, WorktreeRecord>();
    for (const r of rows) {
      const w = byPath.get(r.worktree_path) ?? {
        worktreePath: r.worktree_path,
        issues: [],
        prNumber: null,
        reviewedHeadSha: null,
      };
      w.issues.push(r.number);
      w.prNumber ??= r.pr_number;
      w.reviewedHeadSha ??= r.reviewed_head_sha;
      byPath.set(r.worktree_path, w);
    }
    return [...byPath.values()];
  }

  /** End of the usage-limit pause (REQ-001-17), if one is in force or was recorded. */
  pausedUntil(): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("pausedUntil")?.value;
  }

  setPausedUntil(iso: string | undefined): void {
    if (iso === undefined) this.db.query("DELETE FROM meta WHERE key = ?").run("pausedUntil");
    else this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("pausedUntil", iso);
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
