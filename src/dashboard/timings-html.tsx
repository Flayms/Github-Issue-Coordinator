/**
 * The Timings page (REQ-003-34): how long each step of one issue took, as a row of segments per phase. Rendered
 * on the server like the other pages (REQ-003-19); the picker is a GET form, so it works without JavaScript.
 * The CSP forbids inline styles, so a segment's width is the `width` attribute of an empty `<svg>`.
 */
import type { TimingKind } from "../store.ts";
import type { SegmentView, TimingsView } from "./timings.ts";
import { Empty, Footer, Layout, Link, renderPage } from "./ui.tsx";
import type { DashboardView } from "./view.ts";

/** Grey = waiting in the queue, indigo = an agent working, dark indigo = checks, hatched = the Owner's time. */
const FILL: Record<TimingKind, string> = {
  queued: "bg-white/12",
  agent: "bg-acc-hi",
  checks: "bg-acc-lo",
  owner: "border border-line-2 bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.14)_0_3px,transparent_3px_7px)]",
};

const LEGEND: [TimingKind, string][] = [
  ["queued", "waiting in the queue"],
  ["agent", "agent working"],
  ["checks", "checks"],
  ["owner", "your time (optional)"],
];

const Dot = ({ kind }: { kind: TimingKind }) => (
  <span className={`inline-block size-2 shrink-0 rounded-full ${FILL[kind]}`} aria-hidden="true" />
);

const Bar = ({ segments }: { segments: SegmentView[] }) => (
  <div className="flex gap-[3px]" aria-hidden="true">
    {segments.map((s) => (
      <svg
        key={s.label}
        width={`${s.share}%`}
        height="28"
        className={`block h-7 min-w-1 shrink rounded-md ${FILL[s.kind]}`}
      />
    ))}
  </div>
);

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

function Chart({ t }: { t: TimingsView }) {
  const totals = t.totals;
  if (!totals) return null;
  const big = "font-bold font-display text-[22px] tracking-[-0.01em]";
  return (
    <div className="panel px-5 py-5 sm:px-7">
      <ul className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-line border-b pb-5 text-[13px] text-muted">
        <li>
          <b className={`${big} text-white`}>{totals.total}</b> {totals.totalLabel}
        </li>
        <li>
          <b className={`${big} text-acc-hi`}>{totals.agents}</b> agents working
        </li>
        <li>
          <b className={`${big} text-white`}>{totals.rounds}</b> Revise / Feedback rounds
        </li>
      </ul>
      {t.rows.map((r) => (
        <section
          key={r.phase}
          className="grid gap-x-6 gap-y-3 border-line border-b py-5 sm:grid-cols-[110px_minmax(0,1fr)]"
        >
          <h2 className="font-semibold text-[14px] text-fg">{r.phase}</h2>
          <div className="min-w-0">
            <Bar segments={r.segments} />
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-muted">
              {r.segments.map((s) => (
                <li key={s.label} className="inline-flex items-center gap-1.5">
                  <Dot kind={s.kind} />
                  <span>{s.label}</span>
                  <b className="font-semibold text-fg">{s.duration}</b>
                  {s.running && <span className="text-acc-hi">running</span>}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 pt-4 text-[12px] text-faint">
        {LEGEND.map(([kind, text]) => (
          <li key={kind} className="inline-flex items-center gap-1.5">
            <Dot kind={kind} />
            {text}
          </li>
        ))}
      </ul>
    </div>
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
