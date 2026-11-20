/**
 * The Timings page's view model (REQ-003-34): one issue's recorded Timings (REQ-003-33) as one row per phase
 * on one shared time axis, each step placed where it really started. Without the Owner's time, that time is
 * cut out of the axis, so the steps close up. Pure, so it is tested without a store or a server.
 */
import type { Role } from "../config.ts";
import type { TimedIssue, Timing, TimingKind, TimingPhase } from "../store.ts";
import { formatDuration } from "./view.ts";

/** What the page reads from the store; the store itself in the Coordinator. */
export interface TimingSource {
  timedIssues(): TimedIssue[];
  timings(repo: string, issue: number): Timing[];
}

export interface StepView {
  label: string;
  duration: string;
  kind: TimingKind;
  /** Where it starts and how long it lasts, in % of the issue's axis, two decimals. */
  at: number;
  width: number;
  /** The same on its phase's own scale, for a phone. */
  phaseAt: number;
  phaseWidth: number;
  /** Its track in the row: a step that overlaps one before it (checks alongside the Review) goes on the next. */
  lane: number;
  /** An agent still working: the step grows until now. */
  running: boolean;
}

export interface TimingRowView {
  phase: string;
  /** From the phase's first start to its last end, on the axis. */
  duration: string;
  lanes: number;
  steps: StepView[];
}

/** A time mark over the rows, at `at` % of the axis. */
export interface MarkView {
  label: string;
  at: number;
}

export interface TimingsView {
  /** The picker: every issue with Timings, the newest first; the value is `owner/repo#n`. */
  issues: { value: string; label: string; selected: boolean }[];
  includeOwner: boolean;
  picked: { repo: string; issue: number; title: string | null; url: string } | null;
  rows: TimingRowView[];
  /** How long the axis is, and its time marks. */
  axis: string;
  marks: MarkView[];
  totals: {
    total: string;
    totalLabel: string;
    agents: string;
    agentsPercent: number;
    queued: string;
    queuedPercent: number;
    rounds: number;
  } | null;
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
  /** Its intervals as [start, end] in ms, for the totals. */
  spans: [number, number][];
}

/** How long any of the spans lasted: time they overlap (checks alongside the Review) counts once. */
function covered(spans: [number, number][]): number {
  let total = 0;
  let until = Number.NEGATIVE_INFINITY;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (end <= until) continue;
    total += end - Math.max(start, until);
    until = end;
  }
  return total;
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

/** The spans merged where they overlap or touch, in order. */
function merge(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** The parts of `spans` that none of `cover` overlaps. */
function minus(spans: [number, number][], cover: [number, number][]): [number, number][] {
  let rest = merge(spans);
  for (const [cs, ce] of merge(cover))
    rest = rest.flatMap(([s, e]): [number, number][] =>
      ce <= s || cs >= e
        ? [[s, e]]
        : [...(cs > s ? [[s, cs] as [number, number]] : []), ...(ce < e ? [[ce, e] as [number, number]] : [])],
    );
  return rest;
}

const MIN = 60_000;
/** Spacings of the time marks; the first that gives at most 5 marks is used. */
const MARK_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 7200, 14400].map((m) => m * MIN);
const MAX_MARKS = 5;

function markLabel(ms: number): string {
  const min = Math.round(ms / MIN);
  if (min === 0) return "0";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

function marks(axisMs: number): MarkView[] {
  if (axisMs <= 0) return [];
  const step =
    MARK_STEPS.find((s) => axisMs / s <= MAX_MARKS) ??
    (MARK_STEPS.at(-1) as number) * Math.ceil(axisMs / (MARK_STEPS.at(-1) as number) / MAX_MARKS);
  const out: MarkView[] = [];
  for (let t = 0; t < axisMs; t += step) out.push({ label: markLabel(t), at: round2((t / axisMs) * 100) });
  return out;
}

/** One label line's entry: the step (its index in the row) and where its label stands, in % of the axis. */
export interface PlacedLabel {
  step: number;
  from: number;
  to: number;
  /** "end" for a label that would run past the axis: it ends where its step ends. */
  align: "start" | "end";
}

/** An estimate of the label text at 12 px (the name over the duration), in px, with a little room after it. */
const CHAR_PX = 6.2;
const LABEL_PAD_PX = 8;

/**
 * The labels of a row in lines (REQ-003-34): each under its step's start, on the first line where it doesn't
 * run into the label before it, for a track `trackPx` wide. The page has no layout on the server, so the width
 * of the text is estimated.
 */
export function labelLines(steps: readonly StepView[], trackPx: number): PlacedLabel[][] {
  const lines: PlacedLabel[][] = [];
  steps.forEach((s, step) => {
    const w = ((Math.max(s.label.length, s.duration.length) * CHAR_PX + LABEL_PAD_PX) / trackPx) * 100;
    const end = Math.min(100, s.at + s.width);
    const placed: PlacedLabel =
      s.at + w <= 100
        ? { step, from: s.at, to: round2(s.at + w), align: "start" }
        : { step, from: round2(Math.max(0, end - w)), to: end, align: "end" };
    const line = lines.find((l) => (l.at(-1)?.to ?? 0) <= placed.from);
    line ? line.push(placed) : lines.push([placed]);
  });
  return lines;
}

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
  const base = { issues, includeOwner: o.includeOwner, rows: [], axis: "", marks: [], totals: null };
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
    const g = groups.get(k) ?? {
      phase: t.phase,
      kind: t.kind,
      role: t.role,
      round: t.round,
      ms: 0,
      running: false,
      spans: [],
    };
    const start = Date.parse(t.start);
    g.ms += Math.max(0, end - start);
    g.spans.push([start, Math.max(start, end)]);
    g.running ||= t.end === null;
    groups.set(k, g);
  }
  const rows = (Object.keys(PHASES) as TimingPhase[]).flatMap((phase) => {
    const all = [...groups.values()].filter((g) => g.phase === phase);
    // Labels come from every step, also the ones too short to show, so the Owner's reply before one isn't taken for the last.
    const steps = all
      .map((g, i) => ({ g, label: label(g, i === all.length - 1) }))
      .filter(({ g }) => g.ms >= MIN_MS && (o.includeOwner || g.kind !== "owner"));
    return steps.length ? [{ phase, steps }] : [];
  });
  const shown = rows.flatMap((r) => r.steps.map((s) => s.g));
  const spans = shown.flatMap((g) => g.spans);
  // Without the Owner's time, the time only the Owner spent is cut out of the axis.
  const cuts = o.includeOwner
    ? []
    : minus(
        [...groups.values()].filter((g) => g.kind === "owner").flatMap((g) => g.spans),
        spans,
      );
  const origin = Math.min(...spans.map(([start]) => start));
  /** A time on the axis, in ms from its start. */
  const onAxis = (t: number) =>
    t - origin - cuts.reduce((cut, [s, e]) => cut + Math.max(0, Math.min(e, t) - Math.max(s, origin)), 0);
  const axisMs = onAxis(Math.max(...spans.map(([, end]) => end)));
  const pct = (ms: number, of: number) => (of > 0 ? round2((ms / of) * 100) : 0);
  const sum = (gs: Group[]) => covered(gs.flatMap((g) => g.spans));
  const totalMs = sum(shown);
  const agentsMs = sum(shown.filter((g) => g.kind === "agent"));
  const queuedMs = sum(shown.filter((g) => g.kind === "queued"));
  const share = (ms: number) => (totalMs > 0 ? Math.round((ms / totalMs) * 100) : 0);
  return {
    ...base,
    picked,
    rows: rows.map((r) => {
      const placed = r.steps.map(({ g, label }) => {
        const start = onAxis(Math.min(...g.spans.map(([s]) => s)));
        const end = onAxis(Math.max(...g.spans.map(([, e]) => e)));
        return { g, label, start, end };
      });
      const phaseStart = Math.min(...placed.map((p) => p.start));
      const phaseMs = Math.max(...placed.map((p) => p.end)) - phaseStart;
      const laneEnds: number[] = [];
      return {
        phase: PHASES[r.phase],
        duration: duration(phaseMs),
        steps: placed.map(({ g, label, start, end }) => {
          let lane = laneEnds.findIndex((e) => e <= start);
          if (lane < 0) lane = laneEnds.length;
          laneEnds[lane] = end;
          return {
            label,
            duration: duration(g.ms),
            kind: g.kind,
            at: pct(start, axisMs),
            width: pct(end - start, axisMs),
            phaseAt: pct(start - phaseStart, phaseMs),
            phaseWidth: pct(end - start, phaseMs),
            lane,
            running: g.running,
          };
        }),
        lanes: laneEnds.length,
      };
    }),
    axis: duration(axisMs),
    marks: marks(axisMs),
    totals: {
      total: duration(totalMs),
      totalLabel: o.includeOwner ? "end to end" : "without your time",
      agents: duration(agentsMs),
      agentsPercent: share(agentsMs),
      queued: duration(queuedMs),
      queuedPercent: share(queuedMs),
      rounds: shown.filter(
        (g) =>
          g.kind === "agent" &&
          ((g.role === "planner" && g.round > 1) || (g.phase === "review" && g.role === "implementer")),
      ).length,
    },
    empty: rows.length ? null : `Nothing recorded for ${key(target)} yet.`,
  };
}
