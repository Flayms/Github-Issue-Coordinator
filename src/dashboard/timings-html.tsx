/**
 * The Timings page (REQ-003-34): how long each step of one issue took, as one row per phase on one shared time
 * axis, each step a glass capsule like a Capacity tube (REQ-003-46). Rendered on the server like the other pages
 * (REQ-003-19); the picker is a GET form, so it works without JavaScript.
 *
 * The CSP forbids inline styles, so a step's place on the axis is the `width` of table cells: a spacer cell up
 * to its start, then its own cell (a table per track, `table-layout: fixed`). On a phone each phase gets its own
 * scale and the labels become a list.
 */
import type { ReactNode } from "react";
import type { TimingKind } from "../store.ts";
import { Tube } from "./html.tsx";
import { labelLines, type MarkView, type StepView, type TimingRowView, type TimingsView } from "./timings.ts";
import { Empty, Footer, Layout, Link, renderPage } from "./ui.tsx";
import type { DashboardView } from "./view.ts";

/**
 * The narrowest track of each label layout, in px, for placing the labels (REQ-003-34): from `sm` to `xl` the
 * phase name stands above the track (`sm`: 640 px less the gutters and the panel's padding); from `xl` it has
 * its own column.
 */
const NARROW_TRACK_PX = 560;
const WIDE_TRACK_PX = 940;

/** Empty glass for a wait in the queue, a liquid for the rest (REQ-003-46). */
const TINT: Record<TimingKind, "checks" | "owner" | undefined> = {
  queued: undefined,
  agent: undefined,
  checks: "checks",
  owner: "owner",
};

const LEGEND: [TimingKind, string][] = [
  ["queued", "waiting in the queue (empty glass)"],
  ["agent", "agent working"],
  ["checks", "checks"],
  ["owner", "your time"],
];

const Pill = ({ kind }: { kind: TimingKind }) => <span className="pill" data-kind={kind} aria-hidden="true" />;

const Capsule = ({ s }: { s: StepView }) => (
  <Tube cols={1} filled={s.kind === "queued" ? 0 : 1} marks={false} tint={TINT[s.kind]} />
);

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One line of cells across the track: each item from `from` to `to` % of it, with spacer cells between. A
 * last cell without a width takes the rest.
 */
function Track({
  items,
  className = "",
  cell = "",
}: {
  items: { key: string; from: number; to: number; node: ReactNode }[];
  className?: string;
  cell?: string;
}) {
  let cursor = 0;
  const cells: ReactNode[] = [];
  for (const it of items) {
    const gap = round2(it.from - cursor);
    if (gap > 0) cells.push(<td key={`gap-${it.key}`} width={`${gap}%`} />);
    cells.push(
      <td
        key={it.key}
        width={`${round2(Math.max(0, it.to - Math.max(cursor, it.from)))}%`}
        className={cell || undefined}
      >
        {it.node}
      </td>,
    );
    cursor = Math.max(cursor, it.to);
  }
  if (cursor < 99.99) cells.push(<td key="rest" />);
  return (
    <table role="presentation" className={`w-full table-fixed border-collapse${className ? ` ${className}` : ""}`}>
      <tbody>
        <tr>{cells}</tr>
      </tbody>
    </table>
  );
}

/** The capsules of a row, a track per lane (steps that overlap go on the next one). */
function Lanes({ row, scale }: { row: TimingRowView; scale: "issue" | "phase" }) {
  return (
    <div className="relative grid gap-1.5" aria-hidden="true">
      {Array.from({ length: row.lanes }, (_, lane) => (
        <Track
          // biome-ignore lint/suspicious/noArrayIndexKey: the lanes are numbered and never reorder
          key={lane}
          cell="px-px align-middle"
          items={row.steps.flatMap((s, i) => {
            if (s.lane !== lane) return [];
            const [at, width] = scale === "issue" ? [s.at, s.width] : [s.phaseAt, s.phaseWidth];
            return [{ key: String(i), from: at, to: at + width, node: <Capsule s={s} /> }];
          })}
        />
      ))}
    </div>
  );
}

const Running = ({ s }: { s: StepView }) => (s.running ? <span className="ml-1 text-acc-hi">running</span> : null);

/** The labels under a row's capsules, in lines so they don't run into each other (REQ-003-34). */
function Labels({ steps, trackPx, className }: { steps: StepView[]; trackPx: number; className: string }) {
  return (
    <div className={`mt-2.5 space-y-1.5 ${className}`}>
      {labelLines(steps, trackPx).map((line) => (
        <Track
          key={line.map((l) => l.step).join(" ")}
          className="text-[12px] leading-snug"
          items={line.map((l) => {
            const s = steps[l.step] as StepView;
            return {
              key: String(l.step),
              from: l.from,
              to: l.to,
              node: (
                <span
                  className={`block whitespace-nowrap border-line-2 text-muted ${l.align === "end" ? "border-r pr-2 text-right" : "border-l pl-2"}`}
                >
                  {s.label}
                  <b className="block font-semibold text-fg">
                    {s.duration}
                    <Running s={s} />
                  </b>
                </span>
              ),
            };
          })}
        />
      ))}
    </div>
  );
}

/** Dashed lines at the time marks, behind a row's capsules. */
const MarkLines = ({ marks }: { marks: MarkView[] }) => (
  <div className="absolute inset-0" aria-hidden="true">
    <Track
      className="h-full"
      cell="border-white/6 border-l border-dashed"
      items={marks.map((m, i) => ({ key: m.label, from: m.at, to: marks[i + 1]?.at ?? 100, node: null }))}
    />
  </div>
);

const ROW = "grid gap-x-6 gap-y-3 xl:grid-cols-[110px_minmax(0,1fr)]";

/** The timeline on one axis, from `sm` up. */
function Timeline({ t }: { t: TimingsView }) {
  return (
    <div className="hidden sm:block">
      <div className={`${ROW} pb-2`} aria-hidden="true">
        <span className="hidden xl:block" />
        <Track
          className="font-mono text-[11px] text-faint"
          items={t.marks.map((m, i) => ({
            key: m.label,
            from: m.at,
            to: t.marks[i + 1]?.at ?? 100,
            node: <span className="block whitespace-nowrap">{m.label}</span>,
          }))}
        />
      </div>
      {t.rows.map((r) => (
        <section key={r.phase} className={`${ROW} border-line border-b py-5`}>
          <h2 className="font-semibold text-[14px] text-fg">
            <span>{r.phase}</span> <span className="font-normal text-[12px] text-muted xl:block">{r.duration}</span>
          </h2>
          <div className="relative min-w-0">
            <MarkLines marks={t.marks} />
            <Lanes row={r} scale="issue" />
            <Labels steps={r.steps} trackPx={NARROW_TRACK_PX} className="relative xl:hidden" />
            <Labels steps={r.steps} trackPx={WIDE_TRACK_PX} className="relative hidden xl:block" />
          </div>
        </section>
      ))}
    </div>
  );
}

/** On a phone: each phase on its own scale, the labels as a list with small capsules. */
function PhoneTimeline({ t }: { t: TimingsView }) {
  return (
    <div className="sm:hidden">
      <p className="text-[12px] text-faint">Each phase on its own scale</p>
      {t.rows.map((r) => (
        <section key={r.phase} className="border-line border-b py-5">
          <h2 className="mb-3 flex items-baseline justify-between font-semibold text-[14px] text-fg">
            <span>{r.phase}</span> <span className="font-normal text-[12px] text-muted">{r.duration}</span>
          </h2>
          <Lanes row={r} scale="phase" />
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-muted">
            {r.steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two steps may share a label ("Checks")
              <li key={i} className="inline-flex items-center gap-1.5">
                <Pill kind={s.kind} />
                <span>{s.label}</span>
                <b className="font-semibold text-fg">{s.duration}</b>
                <Running s={s} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Picker({ t }: { t: TimingsView }) {
  return (
    <form
      method="get"
      action="/timings"
      data-autosubmit=""
      className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] sm:ml-auto"
    >
      <select
        name="issue"
        aria-label="Issue"
        defaultValue={t.issues.find((i) => i.selected)?.value}
        className="min-w-0 max-w-full basis-full truncate rounded-full border border-line-2 bg-ink-2 px-3.5 py-2 text-fg sm:max-w-[420px] sm:basis-auto"
      >
        {t.issues.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </select>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line-2 px-3.5 py-2 text-muted has-checked:border-acc has-checked:text-fg">
        <input type="checkbox" name="owner" value="1" defaultChecked={t.includeOwner} className="accent-acc" />
        Include your time
      </label>
      <button
        type="submit"
        className="cursor-pointer rounded-full border border-line-2 px-3.5 py-2 text-muted hover:border-acc hover:text-fg"
      >
        Show
      </button>
    </form>
  );
}

/** A KPI tile above the chart; with a percentage, a small glass tube shows it. */
function Tile({
  value,
  text,
  accent = false,
  percent,
  tint,
}: {
  value: string | number;
  text: string;
  accent?: boolean;
  percent?: number;
  tint?: "queued";
}) {
  return (
    <li className="panel flex flex-col gap-1 px-5 py-4">
      <b className={`font-bold font-display text-[22px] tracking-[-0.01em] ${accent ? "text-acc-hi" : "text-white"}`}>
        {value}
      </b>
      <span className="text-[13px] text-muted">{text}</span>
      {percent !== undefined && (
        <span className="mt-2 grid">
          <Tube cols={10} filled={Math.max(0, Math.min(10, Math.round(percent / 10)))} marks={false} tint={tint} />
        </span>
      )}
    </li>
  );
}

function Chart({ t }: { t: TimingsView }) {
  const totals = t.totals;
  if (!totals) return null;
  return (
    <>
      <ul id="timing-totals" className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Tile value={totals.total} text={`total, ${totals.totalLabel}`} />
        <Tile
          value={totals.agents}
          text={`agents working · ${totals.agentsPercent} %`}
          accent
          percent={totals.agentsPercent}
        />
        <Tile
          value={totals.queued}
          text={`waiting in the queue · ${totals.queuedPercent} %`}
          percent={totals.queuedPercent}
          tint="queued"
        />
        <Tile value={totals.rounds} text="Revise / Feedback rounds" />
      </ul>
      <div id="timeline" className="panel px-5 py-5 sm:px-7">
        <Timeline t={t} />
        <PhoneTimeline t={t} />
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5 pt-4 text-[12px] text-faint">
          {LEGEND.filter(([kind]) => kind !== "owner" || t.includeOwner).map(([kind, text]) => (
            <li key={kind} className="inline-flex items-center gap-1.5">
              <Pill kind={kind} />
              {text}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export function TimingsPage({ v, t }: { v: DashboardView; t: TimingsView }) {
  return (
    <Layout v={v} page="timings">
      <main className="wrap">
        <section className="mt-10 mb-6 flex flex-wrap items-end gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h1 className="font-bold text-[24px] text-white leading-tight">Timings</h1>
            <p className="mt-1 text-[13px] text-muted">
              How long each step of an issue took
              {t.picked && (
                <>
                  {": "}
                  <Link className="text-fg wrap-anywhere hover:text-acc-hi" href={t.picked.url}>
                    {t.picked.repo}#{t.picked.issue}
                    {t.picked.title ? ` ${t.picked.title}` : ""}
                  </Link>
                </>
              )}
            </p>
          </div>
          {t.issues.length > 0 && <Picker t={t} />}
        </section>
        {t.empty ? <Empty>{t.empty}</Empty> : <Chart t={t} />}
      </main>
      <Footer />
    </Layout>
  );
}

export const renderTimings = (v: DashboardView, t: TimingsView): string => renderPage(<TimingsPage v={v} t={t} />);
