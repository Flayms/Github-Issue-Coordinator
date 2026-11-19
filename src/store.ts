/**
 * Local state the labels can't carry: sessions and per-issue bookkeeping (plan.md "Store").
 * Together with the labels it is enough to rebuild state after a restart (REQ-001-16).
 */
import { Database } from "bun:sqlite";
import type { Role } from "./config.ts";
import type { RiskTier } from "./results.ts";

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
  /** The model the session runs, e.g. `claude-opus-5-5`, reported by the hooks (REQ-001-29). */
  modelId: string | null;
  /** Title of the first issue, for the Remote Control name (REQ-001-33); null for a batch Planner and older sessions. */
  title: string | null;
  /** When the session was created (REQ-003-01); null for sessions stored before this was kept. */
  startedAt: string | null;
  /** Name of the Account its last launch ran on (REQ-004-01); null before its first launch and for older sessions. */
  account: string | null;
}

/** An issue the Coordinator created from a Planner's proposal while assessing `parent` (REQ-001-34). */
export interface SplitOff {
  number: number;
  title: string;
}

/** A Worktree on record: its issues (a Bundle shares one), PR and last reviewed head. */
export interface WorktreeRecord {
  worktreePath: string;
  issues: number[];
  prNumber: number | null;
  reviewedHeadSha: string | null;
  feedbackRounds: number;
  pendingFeedback: string | null;
  failedChecksSha: string | null;
  /** Head commit the Coordinator marked ready for review, so it does so once per head (REQ-001-64). */
  readySha: string | null;
  /** Head commit whose merge conflicts already triggered a Feedback round (REQ-001-28). */
  conflictSha: string | null;
  /** Risk tier of the Review of `reviewedHeadSha` (REQ-002-16), for auto-merge (REQ-001-65). */
  reviewRisk: RiskTier | null;
  /** The PR head commit last seen, and when it was first seen, for the checks grace period (REQ-001-64). */
  headSha: string | null;
  headSeenAt: string | null;
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
  /** Review findings (or other feedback) waiting for a Feedback round (REQ-001-11). */
  pendingFeedback: string | null;
  /** Reviews up to this id have been handled (REQ-001-12; kept on the PR's own record). */
  lastHandledReviewId: number;
  /** Head commit whose failed checks already triggered a Feedback round (REQ-001-13). */
  failedChecksSha: string | null;
  /** Head commit the Coordinator marked ready for review, so it does so once per head (REQ-001-64). */
  readySha: string | null;
  /** Head commit whose merge conflicts already triggered a Feedback round (REQ-001-28). */
  conflictSha: string | null;
  /** Risk tier of the Review of `reviewedHeadSha` (REQ-002-16), for auto-merge (REQ-001-65). */
  reviewRisk: RiskTier | null;
  /** The PR head commit last seen, and when it was first seen (REQ-001-64 grace period). */
  headSha: string | null;
  headSeenAt: string | null;
  /** 1 while a Feedback round runs; its next sync returns the issue to agent:pr-open. */
  inFeedbackRound: number;
  /** JSON `{ headSha, causes }` while an automatic Feedback round runs, to report a stall (REQ-001-38). */
  autoRound: string | null;
  /** The latest Review's findings (JSON), until the Implementer has answered them (REQ-001-35). */
  reviewFindings: string | null;
  /** Earlier Review findings with the Implementer's answers, for a re-review (REQ-001-36). */
  reviewHistory: string | null;
  /** The Owner's comments whose revision still owes them a Reply (REQ-001-40); empty when none is pending. */
  replyTo: number[];
  /** The PR body's last `## Screenshots` section (REQ-001-50), kept for turns without Screenshots. */
  screenshots: string | null;
}

/** What the Coordinator did, by kind; the dashboard picks an icon and tone by it (REQ-003-15, REQ-003-16). */
export type EventKind =
  | "assessed"
  | "approved"
  | "blocked"
  | "unblocked"
  | "pr-opened"
  | "review-passed"
  | "review-findings"
  | "auto-merged"
  | "merge-refused"
  | "feedback-round"
  | "failed";

/** One thing the Coordinator did on GitHub, for the dashboard's Recent column (REQ-003-15). */
export interface CoordinatorEvent {
  at: string;
  repo: string;
  kind: EventKind;
  issues: number[];
  pr: number | null;
  /** A short sentence, e.g. "PR #70 opened for #5"; for a failure, with the reason. */
  text: string;
}

/** How many Events the store keeps (REQ-003-15). */
export const EVENTS_KEPT = 200;

/** The phase a Timing belongs to, one row each on the Timings page (REQ-003-34). */
export type TimingPhase = "planning" | "building" | "review";
/** What the time was spent on: waiting in the queue, an agent working, checks running, or the Owner's move (REQ-003-33). */
export type TimingKind = "queued" | "agent" | "checks" | "owner";

/** One recorded interval of an issue's history (REQ-003-33). */
export interface Timing {
  repo: string;
  issue: number;
  /** The issue's title when the interval was recorded, for the Timings page's picker. */
  title: string | null;
  phase: TimingPhase;
  kind: TimingKind;
  /** The agent's Role; null for checks and the Owner's time. */
  role: Role | null;
  /** 1 for the first step of its kind in the phase, 2 for the next (a revision, a Feedback round, a re-review), … */
  round: number;
  start: string;
  /** Null while it lasts: an agent session still running. */
  end: string | null;
  /** The agent session, for agent intervals. */
  sessionId: number | null;
}

/** One rate-limit window of a Usage quota (REQ-001-67). */
export interface QuotaWindow {
  /** 0 to 100. */
  usedPercent: number;
  /** ISO time the window resets. */
  resetsAt: string;
}

/** An Account's latest Usage quota, as its sessions' status lines reported it (REQ-001-67). */
export interface UsageQuota {
  /** Null until a session reported this window. */
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  /** When a session last reported it. */
  seenAt: string;
}

/** An issue with recorded Timings, for the Timings page's picker (REQ-003-34). */
export interface TimedIssue {
  repo: string;
  issue: number;
  title: string | null;
  /** The end of its latest interval (or the start of one that lasts). */
  lastAt: string;
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
  usage_limited INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  title TEXT,
  started_at TEXT,
  account TEXT
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
  last_handled_review_id INTEGER NOT NULL DEFAULT 0,
  failed_checks_sha TEXT,
  ready_sha TEXT,
  review_risk TEXT,
  conflict_sha TEXT,
  head_sha TEXT,
  head_seen_at TEXT,
  in_feedback_round INTEGER NOT NULL DEFAULT 0,
  review_findings TEXT,
  review_history TEXT,
  reply_to TEXT,
  auto_round TEXT,
  screenshots TEXT,
  PRIMARY KEY (repo, number)
);
CREATE TABLE IF NOT EXISTS split_offs (
  repo TEXT NOT NULL,
  parent INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE TABLE IF NOT EXISTS account_pauses (
  account TEXT PRIMARY KEY,
  until TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_quotas (
  account TEXT PRIMARY KEY,
  five_hour TEXT,
  seven_day TEXT,
  seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,
  issues TEXT NOT NULL,
  pr INTEGER,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS timings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  title TEXT,
  phase TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT,
  round INTEGER NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  session_id INTEGER,
  head_sha TEXT
);
CREATE INDEX IF NOT EXISTS timings_issue ON timings (repo, issue);
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
  model_id: string | null;
  title: string | null;
  started_at: string | null;
  account: string | null;
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
  modelId: r.model_id ?? null,
  title: r.title ?? null,
  startedAt: r.started_at ?? null,
  account: r.account ?? null,
});

interface TimingRow {
  id: number;
  repo: string;
  issue: number;
  title: string | null;
  phase: TimingPhase;
  kind: TimingKind;
  role: Role | null;
  round: number;
  start_at: string;
  end_at: string | null;
  session_id: number | null;
  head_sha: string | null;
}

const toTiming = (r: TimingRow): Timing => ({
  repo: r.repo,
  issue: r.issue,
  title: r.title,
  phase: r.phase,
  kind: r.kind,
  role: r.role,
  round: r.round,
  start: r.start_at,
  end: r.end_at,
  sessionId: r.session_id,
});

/** A time in the store's one format, so times compare as text; undefined for a missing or unreadable one. */
const iso = (t: string | undefined): string | undefined => {
  const ms = t === undefined ? Number.NaN : Date.parse(t);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

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
  lastHandledReviewId: "last_handled_review_id",
  failedChecksSha: "failed_checks_sha",
  readySha: "ready_sha",
  conflictSha: "conflict_sha",
  reviewRisk: "review_risk",
  headSha: "head_sha",
  headSeenAt: "head_seen_at",
  inFeedbackRound: "in_feedback_round",
  autoRound: "auto_round",
  reviewFindings: "review_findings",
  reviewHistory: "review_history",
  replyTo: "reply_to",
  screenshots: "screenshots",
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
    this.migrate();
  }

  /** Adds columns introduced after a store was created; CREATE TABLE IF NOT EXISTS leaves old tables as they are. */
  private migrate(): void {
    const added: Record<string, Record<string, string>> = {
      issues: {
        conflict_sha: "TEXT",
        head_sha: "TEXT",
        head_seen_at: "TEXT",
        review_findings: "TEXT",
        review_history: "TEXT",
        reply_to: "TEXT",
        auto_round: "TEXT",
        screenshots: "TEXT",
        ready_sha: "TEXT",
        review_risk: "TEXT",
      },
      sessions: { model_id: "TEXT", title: "TEXT", started_at: "TEXT", account: "TEXT" },
    };
    for (const [table, cols] of Object.entries(added)) {
      const have = new Set(
        this.db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => c.name),
      );
      for (const [col, type] of Object.entries(cols))
        if (!have.has(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }

  clock(): Date {
    return this.now();
  }

  close(): void {
    this.db.close();
  }

  createSession(s: Pick<SessionRecord, "repo" | "role" | "kind" | "issues"> & { title?: string | null }): number {
    const row = this.db
      .query<{ id: number }, Record<string, string | null>>(
        `INSERT INTO sessions (repo, role, kind, issues, title, state, last_activity_at, started_at)
         VALUES ($repo, $role, $kind, $issues, $title, 'running', $at, $at) RETURNING id`,
      )
      .get({
        repo: s.repo,
        role: s.role,
        kind: s.kind,
        issues: JSON.stringify(s.issues),
        title: s.title ?? null,
        at: this.stamp(),
      });
    if (!row) throw new Error("failed to create session");
    this.sessionTimings(row.id, "running");
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

  /** Sessions, open or closed, whose last turn still has to be synced to GitHub (REQ-001-19, REQ-001-27). */
  sessionsToSync(repo: string): SessionRecord[] {
    return this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE repo = ? AND needs_sync = 1 ORDER BY id")
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

  setModelId(id: number, modelId: string): void {
    this.db.query("UPDATE sessions SET model_id = ? WHERE id = ?").run(modelId, id);
  }

  /** Every model a session reported (REQ-001-29), open or closed, each once: what the aliases mean (REQ-003-40). */
  reportedModelIds(): string[] {
    return this.db
      .query<{ model_id: string }, []>(
        "SELECT DISTINCT model_id FROM sessions WHERE model_id IS NOT NULL ORDER BY model_id",
      )
      .all()
      .map((r) => r.model_id);
  }

  setAccount(id: number, account: string): void {
    this.db.query("UPDATE sessions SET account = ? WHERE id = ?").run(account, id);
  }

  setState(id: number, state: SessionState): void {
    this.db.query("UPDATE sessions SET state = ?, last_activity_at = ? WHERE id = ?").run(state, this.stamp(), id);
    this.sessionTimings(id, state);
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
    if (patch.state !== undefined) this.sessionTimings(id, patch.state);
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
      lastHandledReviewId: 0,
      failedChecksSha: null,
      readySha: null,
      conflictSha: null,
      reviewRisk: null,
      headSha: null,
      headSeenAt: null,
      inFeedbackRound: 0,
      autoRound: null,
      reviewFindings: null,
      reviewHistory: null,
      replyTo: [],
      screenshots: null,
    };
    if (row) {
      for (const [key, col] of Object.entries(ISSUE_COLUMNS))
        (rec as unknown as Record<string, unknown>)[key] = row[col];
      rec.replyTo = typeof row.reply_to === "string" ? JSON.parse(row.reply_to) : [];
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
      .run(
        ...(entries.map(([, v]) => (Array.isArray(v) ? JSON.stringify(v) : v)) as (string | number | null)[]),
        repo,
        number,
      );
  }

  /** Worktrees on record (REQ-001-14), grouped by path, with their issues and PR. */
  worktrees(repo: string): WorktreeRecord[] {
    const numbers = this.db
      .query<{ number: number }, [string]>(
        "SELECT number FROM issues WHERE repo = ? AND worktree_path IS NOT NULL ORDER BY number",
      )
      .all(repo)
      .map((r) => r.number);
    const byPath = new Map<string, WorktreeRecord>();
    for (const n of numbers) {
      const r = this.issue(repo, n);
      const path = r.worktreePath as string;
      const w = byPath.get(path);
      if (w) w.issues.push(n);
      else
        byPath.set(path, {
          worktreePath: path,
          issues: [n],
          prNumber: r.prNumber,
          reviewedHeadSha: r.reviewedHeadSha,
          feedbackRounds: r.feedbackRounds,
          pendingFeedback: r.pendingFeedback,
          failedChecksSha: r.failedChecksSha,
          readySha: r.readySha,
          conflictSha: r.conflictSha,
          reviewRisk: r.reviewRisk,
          headSha: r.headSha,
          headSeenAt: r.headSeenAt,
        });
    }
    return [...byPath.values()];
  }

  /** Split-off issues created for a parent issue, oldest first (REQ-001-34). */
  splitOffs(repo: string, parent: number): SplitOff[] {
    return this.db
      .query<SplitOff, [string, number]>(
        "SELECT number, title FROM split_offs WHERE repo = ? AND parent = ? ORDER BY rowid",
      )
      .all(repo, parent);
  }

  recordSplitOff(repo: string, parent: number, s: SplitOff): void {
    this.db
      .query("INSERT OR IGNORE INTO split_offs (repo, parent, number, title) VALUES (?, ?, ?, ?)")
      .run(repo, parent, s.number, s.title);
  }

  /** All Split-off issues of a repository; they are in scope like the Owner's issues (REQ-001-01). */
  splitOffNumbers(repo: string): Set<number> {
    return new Set(
      this.db
        .query<{ number: number }, [string]>("SELECT number FROM split_offs WHERE repo = ?")
        .all(repo)
        .map((r) => r.number),
    );
  }

  /** End of the Account's usage-limit pause (REQ-001-17), if one is in force or was recorded. */
  pausedUntil(account: string): string | undefined {
    return this.db.query<{ until: string }, [string]>("SELECT until FROM account_pauses WHERE account = ?").get(account)
      ?.until;
  }

  setPausedUntil(account: string, iso: string | undefined): void {
    if (iso === undefined) this.db.query("DELETE FROM account_pauses WHERE account = ?").run(account);
    else this.db.query("INSERT OR REPLACE INTO account_pauses (account, until) VALUES (?, ?)").run(account, iso);
  }

  /** REQ-001-67: the Account's latest Usage quota, if a session ever reported one. */
  usageQuota(account: string): UsageQuota | undefined {
    const row = this.db
      .query<{ five_hour: string | null; seven_day: string | null; seen_at: string }, [string]>(
        "SELECT five_hour, seven_day, seen_at FROM usage_quotas WHERE account = ?",
      )
      .get(account);
    if (!row) return undefined;
    const window = (json: string | null): QuotaWindow | null => (json === null ? null : JSON.parse(json));
    return { fiveHour: window(row.five_hour), sevenDay: window(row.seven_day), seenAt: row.seen_at };
  }

  /** REQ-001-67: records a report at the store's time; a window missing from it keeps its last values. */
  recordUsageQuota(account: string, report: { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow }): void {
    const last = this.usageQuota(account);
    const fiveHour = report.fiveHour ?? last?.fiveHour ?? null;
    const sevenDay = report.sevenDay ?? last?.sevenDay ?? null;
    this.db
      .query("INSERT OR REPLACE INTO usage_quotas (account, five_hour, seven_day, seen_at) VALUES (?, ?, ?, ?)")
      .run(account, fiveHour && JSON.stringify(fiveHour), sevenDay && JSON.stringify(sevenDay), this.stamp());
  }

  /** Stores before spec 004 kept one pause for everything; it becomes the given Account's (the first one's). */
  adoptLegacyPause(account: string): void {
    const legacy = this.db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get("pausedUntil");
    if (!legacy) return;
    if (this.pausedUntil(account) === undefined) this.setPausedUntil(account, legacy.value);
    this.db.query("DELETE FROM meta WHERE key = ?").run("pausedUntil");
  }

  /** Records an Event at the store's time and drops all but the newest EVENTS_KEPT (REQ-003-15). */
  recordEvent(e: Omit<CoordinatorEvent, "at">): void {
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO events (at, repo, kind, issues, pr, text) VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.stamp(), e.repo, e.kind, JSON.stringify(e.issues), e.pr, e.text);
      this.db
        .query("DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)")
        .run(EVENTS_KEPT);
    })();
  }

  /** The kept Events, newest first (REQ-003-16). */
  events(): CoordinatorEvent[] {
    return this.db
      .query<Omit<CoordinatorEvent, "issues"> & { issues: string }, []>(
        "SELECT at, repo, kind, issues, pr, text FROM events ORDER BY id DESC",
      )
      .all()
      .map((r) => ({ ...r, issues: JSON.parse(r.issues) }));
  }

  /**
   * REQ-003-33: the one place agent intervals open and close. Every change of a session's state goes through the
   * store (the runner, the hooks, the reconcile loop), so a session that starts running opens an interval for each
   * of its issues, in the issue's current step of the session's Role, and one that stops closes them.
   */
  private sessionTimings(id: number, state: SessionState): void {
    const at = this.stamp();
    if (state !== "running") {
      this.db.query("UPDATE timings SET end_at = ? WHERE session_id = ? AND end_at IS NULL").run(at, id);
      return;
    }
    const s = this.session(id);
    if (!s) return;
    for (const issue of s.issues) {
      const open = this.db
        .query<{ id: number }, [number, number]>(
          "SELECT id FROM timings WHERE session_id = ? AND issue = ? AND end_at IS NULL",
        )
        .get(id, issue);
      const step = this.latestStep(s.repo, issue, { role: s.role });
      if (open || !step) continue;
      this.insertTiming({ ...step, kind: "agent", start: at, end: null, sessionId: id });
    }
  }

  /**
   * The issue's step (its queued interval) that began last, optionally of one Role and phase. A step begins when its
   * wait ends, also when a retried start extends it; rounds count per phase, so they don't order steps across phases.
   */
  private latestStep(repo: string, issue: number, o: { role: Role; phase?: TimingPhase }): TimingRow | undefined {
    return (
      this.db
        .query<TimingRow, [string, number, string, string | null]>(
          `SELECT * FROM timings WHERE repo = ? AND issue = ? AND kind = 'queued' AND role = ?
           AND (?4 IS NULL OR phase = ?4) ORDER BY end_at DESC, id DESC LIMIT 1`,
        )
        .get(repo, issue, o.role, o.phase ?? null) ?? undefined
    );
  }

  /**
   * The end of the issue's latest interval (the start of one that lasts), or null without Timings. Checks run
   * alongside the steps (REQ-001-64), so they don't move it; an issue has checks only after other intervals.
   */
  private lastEnd(repo: string, issue: number): string | null {
    return (
      this.db
        .query<{ at: string | null }, [string, number]>(
          "SELECT MAX(COALESCE(end_at, start_at)) AS at FROM timings WHERE repo = ? AND issue = ? AND kind != 'checks'",
        )
        .get(repo, issue)?.at ?? null
    );
  }

  private latestTitle(repo: string, issue: number): string | null {
    return (
      this.db
        .query<{ title: string }, [string, number]>(
          "SELECT title FROM timings WHERE repo = ? AND issue = ? AND title IS NOT NULL ORDER BY id DESC LIMIT 1",
        )
        .get(repo, issue)?.title ?? null
    );
  }

  private insertTiming(t: Omit<Timing, "title"> & { title?: string | null; headSha?: string | null }): void {
    this.db
      .query(
        `INSERT INTO timings (repo, issue, title, phase, kind, role, round, start_at, end_at, session_id, head_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.repo,
        t.issue,
        t.title ?? this.latestTitle(t.repo, t.issue),
        t.phase,
        t.kind,
        t.role,
        t.round,
        t.start,
        t.end,
        t.sessionId,
        t.headSha ?? null,
      );
  }

  /**
   * REQ-003-33: work of a Role starts on the issue. Records its wait, from `queuedAt` (or where the issue's last
   * interval ended, never before that) until now, as a new round; the session's running time then counts toward it.
   * A step whose agent never ran (a start that failed) is the same round tried again: its wait is extended.
   */
  beginStep(
    repo: string,
    issue: number,
    o: { phase: TimingPhase; role: Role; title?: string | null; queuedAt?: string },
  ): void {
    const now = this.stamp();
    const last = this.latestStep(repo, issue, { role: o.role, phase: o.phase });
    const ran =
      last &&
      this.db
        .query<{ id: number }, [string, number, string, string, number]>(
          "SELECT id FROM timings WHERE repo = ? AND issue = ? AND kind = 'agent' AND phase = ? AND role = ? AND round = ? LIMIT 1",
        )
        .get(repo, issue, o.phase, o.role, last.round);
    if (last && !ran) {
      this.db
        .query("UPDATE timings SET end_at = ?, title = COALESCE(?, title) WHERE id = ?")
        .run(now, o.title ?? null, last.id);
      return;
    }
    const lastEnd = this.lastEnd(repo, issue);
    const queued = iso(o.queuedAt) ?? lastEnd ?? now;
    // ISO times compare as text: the later of the queue time and the last end, but not after now.
    const start = [[queued, lastEnd ?? queued].sort().at(-1) as string, now].sort()[0] as string;
    this.insertTiming({
      repo,
      issue,
      title: o.title,
      phase: o.phase,
      kind: "queued",
      role: o.role,
      round: (last?.round ?? 0) + 1,
      start,
      end: now,
      sessionId: null,
    });
  }

  /**
   * REQ-003-33: the Owner's time or the checks, from `start` (by default where the issue's last interval ended) until
   * `end`. Nothing for an issue without Timings (no backfill) or an `end` not after the start; checks once per head
   * commit, also with no duration. Checks run alongside the Review (REQ-001-64), so they start when their head was pushed.
   */
  recordWait(
    repo: string,
    issue: number,
    o: { phase: TimingPhase; kind: "owner" | "checks"; start?: string; end: string; headSha?: string },
  ): void {
    const last = this.lastEnd(repo, issue);
    const start = last && (iso(o.start) ?? last);
    const end = iso(o.end);
    // A head's checks seen finished at once still mark the head as done, with no duration.
    if (!start || !end || end < start || (end === start && !o.headSha)) return;
    if (o.headSha) {
      const seen = this.db
        .query<{ id: number }, [string, number, string, string]>(
          "SELECT id FROM timings WHERE repo = ? AND issue = ? AND kind = ? AND head_sha = ? LIMIT 1",
        )
        .get(repo, issue, o.kind, o.headSha);
      if (seen) return;
    }
    const round =
      (this.db
        .query<{ round: number | null }, [string, number, string, string]>(
          "SELECT MAX(round) AS round FROM timings WHERE repo = ? AND issue = ? AND phase = ? AND kind = ?",
        )
        .get(repo, issue, o.phase, o.kind)?.round ?? 0) + 1;
    this.insertTiming({
      repo,
      issue,
      phase: o.phase,
      kind: o.kind,
      role: null,
      round,
      start,
      end,
      sessionId: null,
      headSha: o.headSha ?? null,
    });
  }

  /** REQ-003-33: closes the agent intervals of sessions whose window is gone (a crash, a closed window) at now. */
  closeInterruptedTimings(live: Set<number>): void {
    const open = this.db
      .query<{ session_id: number }, []>(
        "SELECT DISTINCT session_id FROM timings WHERE end_at IS NULL AND session_id IS NOT NULL",
      )
      .all();
    const at = this.stamp();
    for (const { session_id } of open)
      if (!live.has(session_id))
        this.db.query("UPDATE timings SET end_at = ? WHERE session_id = ? AND end_at IS NULL").run(at, session_id);
  }

  hasTimings(repo: string, issue: number): boolean {
    return this.lastEnd(repo, issue) !== null;
  }

  /** The issue's Timings in time order (REQ-003-34). */
  timings(repo: string, issue: number): Timing[] {
    return this.db
      .query<TimingRow, [string, number]>("SELECT * FROM timings WHERE repo = ? AND issue = ? ORDER BY start_at, id")
      .all(repo, issue)
      .map(toTiming);
  }

  /** Issues with Timings, the most recently active first (REQ-003-34). */
  timedIssues(): TimedIssue[] {
    return this.db
      .query<TimedIssue, []>(
        `SELECT repo, issue,
           (SELECT t.title FROM timings t WHERE t.repo = x.repo AND t.issue = x.issue AND t.title IS NOT NULL
            ORDER BY t.id DESC LIMIT 1) AS title,
           MAX(COALESCE(end_at, start_at)) AS lastAt
         FROM timings x GROUP BY repo, issue ORDER BY lastAt DESC, repo, issue`,
      )
      .all();
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
