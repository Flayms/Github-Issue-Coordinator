/**
 * Dashboard view model (spec 003): turns the last tick's snapshot and the config into what the page
 * shows. Pure, so every rule is unit-tested; src/dashboard/html.ts renders it.
 */
import { type Config, type Limits, ROLES, roleSettings } from "../config.ts";
import type { RepoSnapshot, TickSnapshot } from "../coordinator.ts";
import type { ChecksState } from "../github/client.ts";
import { ROLE_NAMES } from "../note.ts";
import { remoteControlName } from "../runner.ts";
import type { WaitReason } from "../scheduler.ts";
import { type IssueState, issueState } from "../state.ts";

/** Pipeline columns in the order of the workflow (README "Labels"). */
export const PHASES: IssueState[] = [
  "new",
  "planning",
  "needs-refinement",
  "proposed",
  "wontfix-proposed",
  "approved",
  "blocked",
  "in-progress",
  "pr-open",
  "reviewing",
  "reviewed",
  "failed",
];

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
  pr: PullView | null;
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
  repos: { name: string; setup: string | null; sandboxDomains: string[]; roles: RoleView[] }[];
}

export interface DashboardView {
  lastTick: { at: string; ago: string } | null;
  refreshSec: number;
  pausedUntil: string | null;
  errors: { repo: string; error: string }[];
  sessions: SessionView[];
  readyToMerge: PullView[];
  queue: QueueView[];
  blocked: BlockedView[];
  columns: { phase: IssueState; issues: IssueView[] }[];
  settings: SettingsView;
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

export function dashboardView(snap: TickSnapshot | undefined, config: Config, now: Date): DashboardView {
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

  const issues: (IssueView & { phase: IssueState })[] = repos.flatMap((r) => {
    const pulls = pullsOf(r);
    return r.issues.map((i) => ({
      repo: r.repo,
      number: i.number,
      title: i.title,
      url: issueUrl(r.repo, i.number),
      phase: issueState(i.labels),
      pr: pulls.find((p) => p.issues.includes(i.number)) ?? null,
    }));
  });
  const columns = PHASES.map((phase) => ({
    phase,
    issues: issues
      .filter((i) => i.phase === phase)
      .sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)
      .map(({ phase: _, ...i }) => i),
  })).filter((c) => c.issues.length > 0);

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

  return {
    lastTick: snap ? { at: formatTime(snap.finishedAt), ago: `${formatDuration(since(snap.finishedAt))} ago` } : null,
    refreshSec: config.pollIntervalSec,
    pausedUntil:
      snap?.pausedUntil && Date.parse(snap.pausedUntil) > now.getTime() ? formatTime(snap.pausedUntil) : null,
    errors: repos.flatMap((r) => (r.error ? [{ repo: r.repo, error: r.error }] : [])),
    sessions,
    readyToMerge,
    queue,
    blocked,
    columns,
    settings: settingsView(config),
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

function settingsView(config: Config): SettingsView {
  return {
    pollIntervalSec: config.pollIntervalSec,
    checksGraceSeconds: config.checksGraceSeconds,
    limits: { ...config.limits },
    repos: config.repos.map((r) => ({
      name: r.name,
      setup: r.setup ?? null,
      sandboxDomains: [...r.sandboxDomains],
      roles: ROLES.map((role) => {
        const s = roleSettings(config, r.name, role);
        return { role: ROLE_NAMES[role], model: s.model, effort: s.effort ?? null };
      }),
    })),
  };
}
