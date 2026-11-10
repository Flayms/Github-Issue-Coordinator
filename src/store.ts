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
  last_activity_at TEXT NOT NULL
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
  PRIMARY KEY (repo, number)
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
});

const ISSUE_COLUMNS = {
  lastHandledCommentId: "last_handled_comment_id",
  assessmentCommentId: "assessment_comment_id",
  feedbackRounds: "feedback_rounds",
  reviewedHeadSha: "reviewed_head_sha",
  prNumber: "pr_number",
  worktreePath: "worktree_path",
} as const satisfies Record<Exclude<keyof IssueRecord, "repo" | "number">, string>;

export class Store {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
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

  private stamp(): string {
    return this.now().toISOString();
  }
}
