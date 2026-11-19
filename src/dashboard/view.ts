/**
 * Dashboard view model (spec 003): turns the last tick's snapshot and the config into what the page
 * shows. Pure, so every rule is unit-tested; src/dashboard/html.tsx renders it.
 */
import {
  type AutoMergeMode,
  autoMergeMode,
  type Config,
  githubLoginOf,
  type Limits,
  ROLES,
  type Role,
  roleSettings,
} from "../config.ts";
import type { AccountSnapshot, RepoSnapshot, TickSnapshot } from "../coordinator.ts";
import type { ChecksState } from "../github/client.ts";
import { ROLE_NAMES } from "../note.ts";
import { remoteControlName } from "../runner.ts";
import type { WaitReason, WorkKind } from "../scheduler.ts";
import { type IssueState, issueState } from "../state.ts";
import type { EventKind, QuotaWindow } from "../store.ts";

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

/** REQ-003-16 / REQ-003-17: success `ok`, neutral `muted`, attention `warn` (the Owner's move only), failure `bad`. */
const EVENT_TONES: Record<EventKind, Tone> = {
  assessed: "warn",
  approved: "muted",
  blocked: "muted",
  unblocked: "muted",
  "pr-opened": "ok",
  "review-passed": "ok",
  "review-findings": "muted",
  "auto-merged": "ok",
  "merge-refused": "warn",
  "feedback-round": "muted",
  failed: "bad",
};

/**
 * REQ-003-32: the groups of Your move in their order, each with the phase of its issues (ready PRs
 * come from the merge filter instead) and the hint every row of the group shows.
 */
const MOVES: { kind: MoveKind; title: string; phase?: IssueState; hint: string }[] = [
  { kind: "merge", title: "Merge PRs", hint: "Reviewed: merge it" },
  { kind: "failed", title: "Failed", phase: "failed", hint: "The Coordinator gave up; see its comment" },
  { kind: "questions", title: "Answer questions", phase: "needs-refinement", hint: "The Planner has questions" },
  { kind: "approve", title: "Approve plans", phase: "proposed", hint: "Assessment ready: approve or reply" },
  { kind: "close", title: "Close?", phase: "wontfix-proposed", hint: "The Planner proposes not to do it" },
];

/**
 * Colour by meaning (REQ-003-17): `acc` an agent is on it, `ok` ready to merge, `warn` only the
 * Owner's move, `bad` only a failure, `muted` waiting or blocked.
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
  /** `limits.idleTimeoutMin`, after which an idle session is closed (REQ-003-01). */
  idleTimeout: string;
  /** Idle time out of the idle timeout in percent, rounded to 10 for the bar; null unless idle. */
  idleShare: number | null;
  /** When the scheduler closes an idle session, e.g. `in 12 min` or `at the next tick` (#74); null unless idle. */
  closesIn: string | null;
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

/** REQ-003-11: the headline's count and the three counts under it. */
export interface SummaryView {
  /** Every item of Your move (REQ-003-32). */
  needYou: number;
  /** Running sessions. */
  working: number;
  /** Queued work that waits for a slot. */
  queued: number;
  /** Blocked issues. */
  blocked: number;
}

export type MoveKind = "merge" | "failed" | "questions" | "approve" | "close";

/** A row of Your move: an agent PR to merge or an issue, linked to GitHub (REQ-003-32). */
export interface MoveItem extends IssueLink {
  repo: string;
  /** `PR #70` or `#5`. */
  label: string;
  /** A ready PR's checks, `checks passed` or `no checks`, shown at every width; null for an issue. */
  checks: string | null;
  /** What the Owner is to do; the Overview no longer shows it, the group name says it (#139). */
  hint: string;
}

/** A group of Your move; only groups with items are listed. */
export interface MoveGroup {
  kind: MoveKind;
  title: string;
  items: MoveItem[];
}

export interface MeterView {
  label: string;
  used: number;
  limit: number;
}

export interface QueueView {
  key: string;
  kind: WorkKind;
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
  access: { host: string; port: number; tokenRequired: boolean; githubLogin: "on" | "off" | "not set up" } | null;
  /** The model and effort per Role, before repository overrides. */
  roles: RoleView[];
  repos: {
    name: string;
    setup: string | null;
    /** The effective auto-merge mode (REQ-001-65). */
    autoMerge: AutoMergeMode;
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

/** One window of a Usage quota capsule (REQ-003-37). */
export interface QuotaWindowView {
  label: "5-hour" | "weekly";
  /** Whole percent used; null when never reported or past its reset ("–", REQ-003-38). */
  percent: number | null;
  /** From 90 % on: shown in accent (REQ-003-17). */
  high: boolean;
}

/** An Account's Usage quota capsule and the line under it (REQ-003-37, REQ-003-38). */
export interface QuotaView {
  /** Null with a single Account. */
  account: string | null;
  /** `14:30 UTC` (or `Mon 01:00 UTC` on another day) while the Account is paused (REQ-001-17). */
  pausedUntil: string | null;
  windows: QuotaWindowView[];
  /** Whose quota it is and when it resets, e.g. `Claude subscription · resets in 3 h 12 min and Fri 09:00 UTC`. */
  line: string;
  /** `as of 4 min ago`; null when nothing was reported. */
  asOf: string | null;
}

export interface DashboardView {
  lastTick: { at: string } | null;
  refreshSec: number;
  pausedUntil: string | null;
  errors: { repo: string; error: string }[];
  sessions: SessionView[];
  /** Everything that needs the Owner, grouped (REQ-003-32). */
  yourMove: MoveGroup[];
  summary: SummaryView;
  capacity: MeterView[];
  /** One capsule per Account; empty until a session reported its usage or an Account is paused (REQ-003-38). */
  usageQuota: QuotaView[];
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `14:30 UTC` on the same UTC day as `now`, else `Fri 09:00 UTC` (within the coming week). */
export function formatClock(iso: string, now: Date): string {
  const time = `${iso.slice(11, 16)} UTC`;
  return iso.slice(0, 10) === now.toISOString().slice(0, 10) ? time : `${WEEKDAYS[new Date(iso).getUTCDay()]} ${time}`;
}

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

  const idleTimeoutMs = config.limits.idleTimeoutMin * 60_000;
  const idle = (s: { live: boolean; state: string }) => s.live && s.state !== "running";
  const closesIn = (lastActivityAt: string) => {
    const left = idleTimeoutMs - since(lastActivityAt);
    return left >= 60_000 ? `in ${formatDuration(left)}` : "at the next tick";
  };
  // REQ-003-01 (#74): running sessions first, then idle ones, then those whose window is gone.
  const STATE_ORDER = { running: 0, idle: 1, gone: 2 };
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
    idleFor: idle(s) ? formatDuration(since(s.lastActivityAt)) : null,
    idleTimeout: formatDuration(idleTimeoutMs),
    idleShare: idle(s) ? Math.min(100, Math.round((since(s.lastActivityAt) / idleTimeoutMs) * 10) * 10) : null,
    closesIn: idle(s) ? closesIn(s.lastActivityAt) : null,
    name: remoteControlName(s),
    model: s.modelId ?? configuredModel(config, s.repo, s.role),
  }));
  sessions.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

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

  // REQ-003-32 (was REQ-003-03): every issue of the PR reviewed, checks passed (or none), and GitHub can merge it.
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
    kind: q.work.kind,
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

  const usageQuota = quotaViews(snap?.accounts ?? [], now);

  const yourMove: MoveGroup[] = MOVES.map(({ kind, title, phase, hint }) => ({
    kind,
    title,
    items:
      phase === undefined
        ? readyToMerge.map((p) => ({
            repo: p.repo,
            number: p.number,
            title: p.title,
            url: p.url,
            label: `PR #${p.number}`,
            checks: p.checks === "none" ? "no checks" : "checks passed",
            hint,
          }))
        : issues
            .filter((i) => i.phase === phase)
            .map((i) => ({
              repo: i.repo,
              number: i.number,
              title: i.title,
              url: i.url,
              label: `#${i.number}`,
              checks: null,
              hint,
            })),
  })).filter((g) => g.items.length > 0);

  const summary: SummaryView = {
    needYou: yourMove.reduce((n, g) => n + g.items.length, 0),
    working: running.length,
    queued: queue.filter((q) => q.waiting).length,
    blocked: blocked.length,
  };

  return {
    lastTick: snap ? { at: formatTime(snap.finishedAt) } : null,
    refreshSec: config.pollIntervalSec,
    pausedUntil:
      snap?.pausedUntil && Date.parse(snap.pausedUntil) > now.getTime() ? formatTime(snap.pausedUntil) : null,
    errors: repos.flatMap((r) => (r.error ? [{ repo: r.repo, error: r.error }] : [])),
    sessions,
    yourMove,
    summary,
    capacity,
    usageQuota,
    queue,
    blocked,
    columns,
    recent,
    repos: configured,
    repoFilter,
    settings: settingsView(config, repos),
  };
}

/** REQ-003-37 / REQ-003-38: a capsule per Account, or none while no Account reported or is paused. */
function quotaViews(accounts: AccountSnapshot[], now: Date): QuotaView[] {
  const future = (iso: string | null | undefined): iso is string => !!iso && Date.parse(iso) > now.getTime();
  if (!accounts.some((a) => a.quota || future(a.pausedUntil))) return [];
  const named = accounts.length > 1;
  return accounts.map((a) => {
    // Claude Code drops a window once its reset has passed; a stored one past its reset is stale.
    const live = (w: QuotaWindow | null | undefined) => (w && future(w.resetsAt) ? w : null);
    const fiveHour = live(a.quota?.fiveHour);
    const sevenDay = live(a.quota?.sevenDay);
    const window = (label: QuotaWindowView["label"], w: QuotaWindow | null): QuotaWindowView => {
      const percent = w ? Math.round(w.usedPercent) : null;
      return { label, percent, high: percent !== null && percent >= 90 };
    };
    const resets = [
      ...(fiveHour ? [`in ${formatDuration(Date.parse(fiveHour.resetsAt) - now.getTime())}`] : []),
      ...(sevenDay ? [formatClock(sevenDay.resetsAt, now)] : []),
    ];
    const whose = named ? a.name : "Claude subscription";
    return {
      account: named ? a.name : null,
      pausedUntil: future(a.pausedUntil) ? formatClock(a.pausedUntil, now) : null,
      windows: [window("5-hour", fiveHour), window("weekly", sevenDay)],
      line: resets.length ? `${whose} · resets ${resets.join(" and ")}` : whose,
      asOf: a.quota ? `as of ${formatDuration(now.getTime() - Date.parse(a.quota.seenAt))} ago` : null,
    };
  });
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
      return { status: `Blocked by ${blockedBy.map((n) => `#${n}`).join(", ") || "an open issue"}`, tone: "muted" };
    case "in-progress":
      return { status: "The Implementer is building it", tone: "acc" };
    case "pr-open":
      return { status: "Draft PR: waits for checks and a Review", tone: "acc" };
    case "reviewing":
      return { status: "The Reviewer is reviewing the PR", tone: "acc" };
    case "reviewed":
      return ready
        ? { status: "Ready: merge the PR", tone: "ok" }
        : { status: "Reviewed; the PR has conflicts or pending checks", tone: "muted" };
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
    access: dash
      ? {
          host: dash.host,
          port: dash.port,
          tokenRequired: dash.tokenPath !== undefined,
          githubLogin: dash.githubLogin === false ? "off" : githubLoginOf(config) ? "on" : "not set up",
        }
      : null,
    roles: ROLES.map((role) => roleView(role, config.roles[role])),
    repos: config.repos.map((r) => {
      const seen = snapshot.find((x) => x.repo === r.name);
      return {
        name: r.name,
        setup: r.setup ?? null,
        autoMerge: autoMergeMode(config, r.name),
        roles: ROLES.map((role) => roleView(role, roleSettings(config, r.name, role))),
        overrides: ROLES.filter((role) => r.roles?.[role] !== undefined).map((role) =>
          roleView(role, roleSettings(config, r.name, role)),
        ),
        counts: seen ? { issues: seen.issues.length, pulls: seen.pulls.length, worktrees: seen.worktrees } : null,
      };
    }),
  };
}
