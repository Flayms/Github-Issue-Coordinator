/**
 * The Timings page's view model (REQ-003-33): one issue's recorded Timings (REQ-003-32) as rows of segments,
 * one row per phase, on one scale. Pure, so it is tested without a store or a server.
 */
import type { Role } from "../config.ts";
import type { TimedIssue, Timing, TimingKind, TimingPhase } from "../store.ts";
import { formatDuration } from "./view.ts";

/** What the page reads from the store; the store itself in the Coordinator. */
export interface TimingSource {
  timedIssues(): TimedIssue[];
  timings(repo: string, issue: number): Timing[];
}

export interface SegmentView {
  label: string;
  duration: string;
  kind: TimingKind;
  /** Width in % of the longest row, two decimals. */
  share: number;
  /** An agent still working: the segment grows until now. */
  running: boolean;
}

export interface TimingRowView {
  phase: string;
  segments: SegmentView[];
}

export interface TimingsView {
  /** The picker: every issue with Timings, the newest first; the value is `owner/repo#n`. */
  issues: { value: string; label: string; selected: boolean }[];
  includeOwner: boolean;
  picked: { repo: string; issue: number; title: string | null; url: string } | null;
  rows: TimingRowView[];
  totals: { total: string; totalLabel: string; agents: string; rounds: number } | null;
  /** Why there are no rows. */
  empty: string | null;
}

const PHASES: Record<TimingPhase, string> = { planning: "Planning", building: "Building", review: "Review" };
const WAITED_FOR: Record<Role, string> = {
  planner: "Waited for the Planner",
  implementer: "Waited for an Implementer",
  reviewer: "Waited for the Reviewer",
};
/** Shorter steps (a step that started at once) are left out. */
const MIN_MS = 1000;
/** The Owner's time on its own at the end of a row ended it: the approval or the merge. */
const OWNER_LAST: Record<TimingPhase, string> = {
  planning: "Your approval",
  building: "Your time",
  review: "Your merge",
};

interface Group {
  phase: TimingPhase;
  kind: TimingKind;
  role: Role | null;
  round: number;
  ms: number;
  running: boolean;
}

function label(g: Group, last: boolean): string {
  if (g.kind === "queued") return g.role ? WAITED_FOR[g.role] : "Waited";
  if (g.kind === "checks") return "Checks";
  if (g.kind === "owner") return last ? OWNER_LAST[g.phase] : "Your reply";
  if (g.role === "planner") return g.round === 1 ? "Planner" : `Revise ${g.round - 1}`;
  if (g.role === "reviewer") return "Reviewer";
  if (g.phase === "review") return `Feedback round ${g.round}`;
  return g.round === 1 ? "Implementer" : `Implementer, run ${g.round}`;
}

const duration = (ms: number) => (ms < 60_000 ? "< 1 min" : formatDuration(ms));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** `owner/repo#n` → its parts; null for anything else. */
function parsePick(pick: string | null): { repo: string; issue: number } | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(pick ?? "");
  return m ? { repo: m[1] as string, issue: Number(m[2]) } : null;
}

export function timingsView(o: {
  source: TimingSource;
  /** `?issue=owner/repo#n`; the newest issue without one. */
  pick: string | null;
  includeOwner: boolean;
  now: Date;
}): TimingsView {
  const timed = o.source.timedIssues();
  const target = parsePick(o.pick) ?? timed[0] ?? null;
  const key = (t: { repo: string; issue: number }) => `${t.repo}#${t.issue}`;
  const issues = timed.map((t) => ({
    value: key(t),
    label: `${key(t)}${t.title ? ` ${t.title}` : ""}`,
    selected: target !== null && key(t) === key(target),
  }));
  const base = { issues, includeOwner: o.includeOwner, rows: [], totals: null };
  if (!target)
    return { ...base, picked: null, empty: "No Timings recorded yet. They are recorded for work started from now on." };
  const known = timed.find((t) => key(t) === key(target));
  const picked = {
    repo: target.repo,
    issue: target.issue,
    title: known?.title ?? null,
    url: `https://github.com/${target.repo}/issues/${target.issue}`,
  };
  const timings = o.source.timings(target.repo, target.issue);
  if (!timings.length) return { ...base, picked, empty: `Nothing recorded for ${key(target)} yet.` };

  // One segment per step and kind: the intervals of one agent step (a resumed session) add up.
  const groups = new Map<string, Group>();
  for (const t of timings) {
    const k = [t.phase, t.kind, t.role, t.round].join(" ");
    const end = t.end ? Date.parse(t.end) : o.now.getTime();
    const g = groups.get(k) ?? { phase: t.phase, kind: t.kind, role: t.role, round: t.round, ms: 0, running: false };
    g.ms += Math.max(0, end - Date.parse(t.start));
    g.running ||= t.end === null;
    groups.set(k, g);
  }
  const rows = (Object.keys(PHASES) as TimingPhase[]).flatMap((phase) => {
    const all = [...groups.values()].filter((g) => g.phase === phase);
    // Labels come from every step, also the ones too short to show, so the Owner's reply before one isn't taken for the last.
    const segments = all
      .map((g, i) => ({ g, label: label(g, i === all.length - 1) }))
      .filter(({ g }) => g.ms >= MIN_MS && (o.includeOwner || g.kind !== "owner"));
    return segments.length ? [{ phase, segments }] : [];
  });
  const rowMs = rows.map((r) => r.segments.reduce((sum, s) => sum + s.g.ms, 0));
  const widest = Math.max(...rowMs, 1);
  const shown = rows.flatMap((r) => r.segments.map((s) => s.g));
  const sum = (gs: Group[]) => gs.reduce((n, g) => n + g.ms, 0);
  return {
    ...base,
    picked,
    rows: rows.map((r) => ({
      phase: PHASES[r.phase],
      segments: r.segments.map(({ g, label }) => ({
        label,
        duration: duration(g.ms),
        kind: g.kind,
        share: round2((g.ms / widest) * 100),
        running: g.running,
      })),
    })),
    totals: {
      total: duration(sum(shown)),
      totalLabel: o.includeOwner ? "end to end" : "without your time",
      agents: duration(sum(shown.filter((g) => g.kind === "agent"))),
      rounds: shown.filter(
        (g) =>
          g.kind === "agent" &&
          ((g.role === "planner" && g.round > 1) || (g.phase === "review" && g.role === "implementer")),
      ).length,
    },
    empty: rows.length ? null : `Nothing recorded for ${key(target)} yet.`,
  };
}
