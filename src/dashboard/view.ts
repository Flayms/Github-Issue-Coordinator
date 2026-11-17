/**
 * Dashboard view model (spec 003): turns the last tick's snapshot and the config into what the page
 * shows. Pure, so every rule is unit-tested; src/dashboard/html.ts renders it.
 */
import { type Config, type Limits, ROLES, type Role, roleSettings } from "../config.ts";
import type { RepoSnapshot, TickSnapshot } from "../coordinator.ts";
import type { ChecksState } from "../github/client.ts";
import { ROLE_NAMES } from "../note.ts";
import { remoteControlName } from "../runner.ts";
import type { WaitReason } from "../scheduler.ts";
import { type IssueState, issueState } from "../state.ts";
import type { EventKind } from "../store.ts";

/** Pipeline columns in the order of the workflow (README "Labels"), each grouping phases (REQ-003-02). */
export const COLUMNS: { title: string; phases: IssueState[] }[] = [
  { title: "Intake", phases: ["new", "planning"] },
  { title: "Your move", phases: ["proposed", "needs-refinement", "wontfix-proposed"] },
  { title: "Approved", phases: ["approved", "blocked"] },
  { title: "Building", phases: ["in-progress"] },
  { title: "In review", phases: ["pr-open", "reviewing"] },
  { title: "Reviewed", phases: ["reviewed"] },
  { title: "Failed", phases: ["failed"] },
];

/** How many Events Recent shows (REQ-003-16). */
export const RECENT_SHOWN = 15;

/** REQ-003-16: success `ok`, neutral `muted`, attention `warn` (the Owner's move or a hold-up), failure `bad`. */
const EVENT_TONES: Record<EventKind, Tone> = {
  assessed: "warn",
  approved: "muted",
  blocked: "warn",
  unblocked: "muted",
  "pr-opened": "ok",
  "review-passed": "ok",
  "review-findings": "muted",
  "feedback-round": "muted",
  failed: "bad",
};

/** Phases where the Owner's move is next (REQ-003-11). */
const NEED_YOU: IssueState[] = ["proposed", "needs-refinement", "wontfix-proposed", "reviewed"];
const STUCK: IssueState[] = ["failed", "blocked"];

/**
 * Colour by meaning: `acc` an agent is on it, `ok` ready to merge, `warn` the Owner's move,
 * `bad` blocked or failed, `muted` waiting for the Coordinator.
 */
export type Tone = "acc" | "ok" | "warn" | "bad" | "muted";

export interface IssueLink {
  number: number;
  title: string;
  url: string;
}

export interface SessionView {
  role: string;
  repo: string;
  issues: IssueLink[];
  /** `gone`: the store has the session open, but its tmux window is not alive. */
  state: "running" | "idle" | "gone";
  startedAt: string | null;
  idleFor: string | null;
  /** The Remote Control name, as shown in the Claude app (REQ-001-33). */
  name: string;
  /** The model the session reported (REQ-001-29), else the configured one. */
  model: string;
}

export interface PullView {
  repo: string;
  number: number;
  title: string;
  url: string;
  issues: number[];
  checks: ChecksState | null;
  mergeable: boolean | null;
  feedbackRounds: number;
  maxFeedbackRounds: number;
}

export interface IssueView extends IssueLink {
  repo: string;
  phase: IssueState;
  /** What is happening, or what the Owner must do (REQ-003-02). */
  status: string;
  tone: Tone;
  pr: PullView | null;
}

export interface ColumnView {
  title: string;
  issues: IssueView[];
}

export interface SummaryView {
  ready: number;
  working: number;
  needYou: number;
  stuck: number;
  queued: number;
}

export interface MeterView {
  label: string;
  used: number;
  limit: number;
}

export interface QueueView {
  key: string;
  status: string;
  waiting: boolean;
}

export interface BlockedView extends IssueLink {
  repo: string;
  blockedBy: { number: number; url: string }[];
}

export interface RoleView {
  role: string;
  model: string;
  effort: string | null;
}

/** An allow-list of settings: anything not named here (keys, tokens, paths) is never shown (REQ-003-05). */
export interface SettingsView {
  pollIntervalSec: number;
  checksGraceSeconds: number;
  limits: Limits;
  /** How the dashboard is reached; null without a `dashboard` block. */
  access: { host: string; port: number; tokenRequired: boolean } | null;
  /** The model and effort per Role, before repository overrides. */
  roles: RoleView[];
  repos: {
    name: string;
    setup: string | null;
    /** Effective settings per Role. */
    roles: RoleView[];
    /** The Roles this repository overrides, with their effective settings. */
    overrides: RoleView[];
    /** From the last tick; null before it. */
    counts: { issues: number; pulls: number; worktrees: number } | null;
  }[];
}

/** One Event in Recent (REQ-003-16). */
export interface EventView {
  repo: string;
  kind: EventKind;
  tone: Tone;
  text: string;
  /** ISO time, for `<time datetime>`. */
  datetime: string;
  at: string;
  ago: string;
  /** The PR first, then the issues. */
  links: { label: string; url: string }[];
}

export interface DashboardView {
  lastTick: { at: string; ago: string } | null;
  refreshSec: number;
  pausedUntil: string | null;
  errors: { repo: string; error: string }[];
  sessions: SessionView[];
  readyToMerge: PullView[];
  summary: SummaryView;
  capacity: MeterView[];
  queue: QueueView[];
  blocked: BlockedView[];
  columns: ColumnView[];
  /** The newest Events, newest first; narrowed by the repository filter (REQ-003-16). */
  recent: EventView[];
  /** All configured repositories, for the filter (REQ-003-13). */
  repos: string[];
  /** The picked repository; null shows all. */
  repoFilter: string | null;
  settings: SettingsView;
}

export interface ViewOptions {
  /** `?repo=`: narrow the Pipeline to one repository (REQ-003-13). */
  repo?: string | null;
}

const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
const pullUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

/** `2026-11-15 10:29 UTC`: the page runs no script, so times are shown in UTC. */
export const formatTime = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function dashboardView(
  snap: TickSnapshot | undefined,
  config: Config,
  now: Date,
  opts: ViewOptions = {},
): DashboardView {
  const repos = snap?.repos ?? [];
  const since = (iso: string) => now.getTime() - Date.parse(iso);
  const title = (repo: string, n: number) =>
    repos.find((r) => r.repo === repo)?.issues.find((i) => i.number === n)?.title;

  const sessions: SessionView[] = (snap?.sessions ?? []).map((s) => ({
    role: ROLE_NAMES[s.role],
    repo: s.repo,
    issues: s.issues.map((n, i) => ({
      number: n,
      title: title(s.repo, n) ?? (i === 0 ? (s.title ?? "") : ""),
      url: issueUrl(s.repo, n),
    })),
    state: s.live ? (s.state === "running" ? "running" : "idle") : "gone",
    startedAt: s.startedAt,
    idleFor: s.live && s.state !== "running" ? formatDuration(since(s.lastActivityAt)) : null,
    name: remoteControlName(s),
    model: s.modelId ?? configuredModel(config, s.repo, s.role),
  }));

  const pullsOf = (r: RepoSnapshot): PullView[] =>
    r.pulls.map((p) => ({
      repo: r.repo,
      number: p.number,
      title: p.title,
      url: pullUrl(r.repo, p.number),
      issues: p.issues,
      checks: p.state?.checks ?? null,
      mergeable: p.state?.mergeable ?? null,
      feedbackRounds: p.feedbackRounds,
      maxFeedbackRounds: config.limits.maxFeedbackRounds,
    }));

  // REQ-003-03: every issue of the PR reviewed, checks passed (or none), and GitHub can merge it.
  const readyToMerge = repos.flatMap((r) =>
    pullsOf(r).filter((p) => {
      const issues = p.issues.map((n) => r.issues.find((i) => i.number === n));
      const reviewed = issues.length > 0 && issues.every((i) => i && issueState(i.labels) === "reviewed");
      return reviewed && (p.checks === "success" || p.checks === "none") && p.mergeable === true;
    }),
  );

  const issues: IssueView[] = repos.flatMap((r) => {
    const pulls = pullsOf(r);
    return r.issues.map((i) => {
      const phase = issueState(i.labels);
      const pr = pulls.find((p) => p.issues.includes(i.number)) ?? null;
      const ready = pr !== null && readyToMerge.some((p) => p.repo === pr.repo && p.number === pr.number);
      return {
        repo: r.repo,
        number: i.number,
        title: i.title,
        url: issueUrl(r.repo, i.number),
        phase,
        ...describe(phase, ready, i.blockedBy),
        pr,
      };
    });
  });
  const configured = config.repos.map((r) => r.name);
  const repoFilter = configured.find((name) => name === opts.repo) ?? null;
  const columns = COLUMNS.map(({ title, phases }) => ({
    title,
    issues: issues
      .filter((i) => phases.includes(i.phase) && (repoFilter === null || i.repo === repoFilter))
      .sort(
        (a, b) =>
          phases.indexOf(a.phase) - phases.indexOf(b.phase) || a.repo.localeCompare(b.repo) || a.number - b.number,
      ),
  }));

  const recent: EventView[] = (snap?.events ?? [])
    .filter((e) => repoFilter === null || e.repo === repoFilter)
    .slice(0, RECENT_SHOWN)
    .map((e) => ({
      repo: e.repo,
      kind: e.kind,
      tone: EVENT_TONES[e.kind] ?? "muted",
      text: e.text,
      datetime: e.at,
      at: formatTime(e.at),
      ago: `${formatDuration(since(e.at))} ago`,
      links: [
        ...(e.pr === null ? [] : [{ label: `PR #${e.pr}`, url: pullUrl(e.repo, e.pr) }]),
        ...e.issues.map((n) => ({ label: `#${n}`, url: issueUrl(e.repo, n) })),
      ],
    }));

  const queue = (snap?.queue ?? []).map((q) => ({
    key: q.work.key,
    status: q.wait ? `waits: ${waitText(q.wait, config.limits)}` : "starts now",
    waiting: q.wait !== undefined,
  }));

  const blocked = repos.flatMap((r) =>
    r.issues
      .filter((i) => issueState(i.labels) === "blocked")
      .map((i) => ({
        repo: r.repo,
        number: i.number,
        title: i.title,
        url: issueUrl(r.repo, i.number),
        blockedBy: i.blockedBy.map((n) => ({ number: n, url: issueUrl(r.repo, n) })),
      })),
  );

  const running = sessions.filter((s) => s.state === "running");
  const runningSessions = (snap?.sessions ?? []).filter((s) => s.live && s.state === "running");
  const slotsOf = (role: Role) => runningSessions.filter((s) => s.role === role).length;
  const max: Record<Role, number> = {
    planner: config.limits.maxPlanners,
    implementer: config.limits.maxImplementers,
    reviewer: config.limits.maxReviewers,
  };
  const capacity: MeterView[] = [
    { label: "Running", used: running.length, limit: config.limits.maxRunning },
    { label: "Live", used: sessions.filter((s) => s.state !== "gone").length, limit: config.limits.maxLiveSessions },
    ...ROLES.map((role) => ({ label: `${ROLE_NAMES[role]} Slots`, used: slotsOf(role), limit: max[role] })),
    { label: "Worktrees", used: repos.reduce((n, r) => n + r.worktrees, 0), limit: config.limits.maxWorktrees },
  ];

  const summary: SummaryView = {
    ready: readyToMerge.length,
    working: running.length,
    needYou: issues.filter((i) => NEED_YOU.includes(i.phase)).length,
    stuck: issues.filter((i) => STUCK.includes(i.phase)).length,
    queued: queue.filter((q) => q.waiting).length,
  };

  return {
    lastTick: snap ? { at: formatTime(snap.finishedAt), ago: `${formatDuration(since(snap.finishedAt))} ago` } : null,
    refreshSec: config.pollIntervalSec,
    pausedUntil:
      snap?.pausedUntil && Date.parse(snap.pausedUntil) > now.getTime() ? formatTime(snap.pausedUntil) : null,
    errors: repos.flatMap((r) => (r.error ? [{ repo: r.repo, error: r.error }] : [])),
    sessions,
    readyToMerge,
    summary,
    capacity,
    queue,
    blocked,
    columns,
    recent,
    repos: configured,
    repoFilter,
    settings: settingsView(config, repos),
  };
}

function waitText(w: WaitReason, limits: Limits): string {
  switch (w.kind) {
    case "paused":
      return `usage-limit pause until ${formatTime(w.until)}`;
    case "max-running":
      return `maxRunning (${limits.maxRunning}) reached`;
    case "slot": {
      const max = { planner: limits.maxPlanners, implementer: limits.maxImplementers, reviewer: limits.maxReviewers };
      return `all ${ROLE_NAMES[w.role]} Slots (${max[w.role]}) in use`;
    }
    case "session-busy":
      return "its session is busy (the Owner may be chatting)";
    case "max-live-sessions":
      return `maxLiveSessions (${limits.maxLiveSessions}) reached`;
    case "max-worktrees":
      return `maxWorktrees (${limits.maxWorktrees}) reached`;
  }
}

/** REQ-003-02: what the issue's phase means for the Owner, in words. */
function describe(phase: IssueState, ready: boolean, blockedBy: number[]): { status: string; tone: Tone } {
  switch (phase) {
    case "new":
      return { status: "Waits for the Planner", tone: "muted" };
    case "planning":
      return { status: "The Planner is assessing it", tone: "acc" };
    case "proposed":
      return { status: "Approve it, or reply to revise", tone: "warn" };
    case "needs-refinement":
      return { status: "Answer the Planner's questions", tone: "warn" };
    case "wontfix-proposed":
      return { status: "Close it, or reply to argue for it", tone: "warn" };
    case "approved":
      return { status: "Waits for an Implementer", tone: "muted" };
    case "blocked":
      return { status: `Blocked by ${blockedBy.map((n) => `#${n}`).join(", ") || "an open issue"}`, tone: "bad" };
    case "in-progress":
      return { status: "The Implementer is building it", tone: "acc" };
    case "pr-open":
      return { status: "Draft PR: waits for checks and a Review", tone: "acc" };
    case "reviewing":
      return { status: "The Reviewer is reviewing the PR", tone: "acc" };
    case "reviewed":
      return ready
        ? { status: "Ready: merge the PR", tone: "ok" }
        : { status: "Reviewed; the PR has conflicts or pending checks", tone: "warn" };
    case "failed":
      return { status: "The Coordinator gave up; see its comment", tone: "bad" };
  }
}

/** A session of a repository no longer configured shows no model rather than failing the page. */
function configuredModel(config: Config, repo: string, role: Role): string {
  try {
    return roleSettings(config, repo, role).model;
  } catch {
    return "–";
  }
}

const roleView = (role: Role, s: { model: string; effort?: string }): RoleView => ({
  role: ROLE_NAMES[role],
  model: s.model,
  effort: s.effort ?? null,
});

function settingsView(config: Config, snapshot: RepoSnapshot[]): SettingsView {
  const dash = config.dashboard;
  return {
    pollIntervalSec: config.pollIntervalSec,
    checksGraceSeconds: config.checksGraceSeconds,
    limits: { ...config.limits },
    access: dash ? { host: dash.host, port: dash.port, tokenRequired: dash.tokenPath !== undefined } : null,
    roles: ROLES.map((role) => roleView(role, config.roles[role])),
    repos: config.repos.map((r) => {
      const seen = snapshot.find((x) => x.repo === r.name);
      return {
        name: r.name,
        setup: r.setup ?? null,
        roles: ROLES.map((role) => roleView(role, roleSettings(config, r.name, role))),
        overrides: ROLES.filter((role) => r.roles?.[role] !== undefined).map((role) =>
          roleView(role, roleSettings(config, r.name, role)),
        ),
        counts: seen ? { issues: seen.issues.length, pulls: seen.pulls.length, worktrees: seen.worktrees } : null,
      };
    }),
  };
}
