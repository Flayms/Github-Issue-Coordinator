/**
 * The Overview (spec 003), as React components rendered on the server (REQ-003-19). The page reads
 * fully without JavaScript; `assets/dashboard.js` only adds the countdown, the copy buttons and the
 * background.
 */
import type { ReactNode } from "react";
import type { WorkKind } from "../scheduler.ts";
import type { EventKind } from "../store.ts";
import {
  Count,
  Empty,
  Footer,
  Heading,
  Icon,
  type IconName,
  Label,
  Layout,
  Link,
  plural,
  renderPage,
  TONE_BG,
  TONE_TEXT,
} from "./ui.tsx";
import type {
  ColumnView,
  DashboardView,
  EventView,
  IssueView,
  MeterView,
  PullView,
  SessionView,
  Tone,
} from "./view.ts";
import { formatTime } from "./view.ts";

const checksText = (p: PullView): { text: string; tone: Tone; icon: IconName } => {
  switch (p.checks) {
    case "success":
      return { text: "checks passed", tone: "ok", icon: "check" };
    case "none":
      return { text: "no checks", tone: "ok", icon: "check" };
    case "failure":
      return { text: "checks failed", tone: "bad", icon: "cross" };
    case "pending":
      return { text: "checks running", tone: "acc", icon: "clock" };
    default:
      return { text: "checks unknown", tone: "muted", icon: "dot" };
  }
};

/**
 * Checks, mergeability and Feedback rounds of an issue's PR. REQ-003-17: the tone colours the icon
 * only; conflicts are neutral, since the Coordinator starts a Feedback round for them (REQ-001-28).
 */
function PrDetails({ p }: { p: PullView }) {
  const c = checksText(p);
  const merge = p.mergeable === true ? "mergeable" : p.mergeable === false ? "conflicts" : "mergeable?";
  return (
    <>
      <span className="inline-flex items-center gap-[3px] text-white/70">
        <Icon name={c.icon} className={`size-[13px] align-[-2px] ${TONE_TEXT[c.tone]}`} />
        {c.text}
      </span>
      <span className="text-white/70">{merge}</span>
      <span className="text-muted">
        rounds {p.feedbackRounds}/{p.maxFeedbackRounds}
      </span>
    </>
  );
}

/** A ready PR: title, a line of facts, and a corner arrow that turns green on hover. */
function ReadyPr({ p }: { p: PullView }) {
  const c = checksText(p);
  const fact = "inline-flex items-center gap-1.5 wrap-anywhere";
  return (
    <li className="border-line border-t first:border-t-0">
      <a
        className="group accent relative flex items-center gap-5 px-[18px] py-4 text-fg transition-[background] duration-600 ease-calm [--accent:var(--color-ok)] hover:bg-linear-to-r hover:from-ok/7 hover:to-transparent hover:to-70% hover:text-fg sm:px-6 sm:py-5"
        href={p.url}
        rel="noreferrer"
      >
        <span className="flex min-w-0 flex-1 flex-col transition-transform duration-450 ease-calm group-hover:translate-x-1.5">
          <span className="font-display font-semibold text-[17px] text-white leading-[1.35] wrap-anywhere">
            {p.title}
          </span>
          <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-white/50">
            <span className={fact}>
              <Icon name="repo" className="size-[13px]" />
              {p.repo}
            </span>
            <span className={fact}>
              <Icon name="pr" className="size-[13px]" />#{p.number}
            </span>
            <span className={fact}>
              <Icon name="shield" className={`size-[13px] ${TONE_TEXT[c.tone]}`} />
              {c.text}
            </span>
          </span>
        </span>
        <span
          className="flex size-10 flex-none items-center justify-center rounded-full bg-white/6 text-white/70 transition-[translate,color,background-color] duration-450 ease-calm group-hover:translate-x-[3px] group-hover:-translate-y-[3px] group-hover:bg-ok group-hover:text-ink"
          title="Open on GitHub"
        >
          <Icon name="arrow" />
        </span>
      </a>
    </li>
  );
}

const SummaryCount = ({ n, label, tone }: { n: number; label: string; tone: Tone }) => (
  <li className="flex items-baseline gap-2">
    <b className={`font-bold font-display text-[26px] leading-none ${TONE_TEXT[n ? tone : "muted"]}`}>{n}</b>
    {label}
  </li>
);

/** REQ-003-11: the headline, the counts and the ready PRs next to them. */
function Summary({ v }: { v: DashboardView }) {
  const s = v.summary;
  return (
    <section
      id="summary"
      className="grid items-start gap-6 pt-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] md:gap-10"
    >
      <div>
        <p className="mb-2.5 font-mono font-semibold text-[12px] text-acc-hi uppercase leading-none tracking-[0.16em]">
          Overview
        </p>
        {/* Plain white, only the number in green (#87). */}
        <h1 className="font-extrabold text-[clamp(40px,6vw,60px)] text-white leading-[1.02] tracking-[-0.03em]">
          {s.ready ? (
            <>
              <span className="text-ok">{s.ready}</span> {s.ready === 1 ? "PR" : "PRs"} ready to merge
            </>
          ) : (
            "Nothing to merge right now"
          )}
        </h1>
        <ul className="mt-[22px] flex flex-wrap gap-x-7 gap-y-2 text-[13px] text-muted">
          <SummaryCount n={s.working} label="working" tone="acc" />
          <SummaryCount n={s.needYou} label="need you" tone="warn" />
          {/* REQ-003-17: stuck counts blocked issues too, so it is not red; failures are red in the Pipeline and Recent. */}
          <SummaryCount n={s.stuck} label="stuck" tone="muted" />
          <SummaryCount n={s.queued} label="queued" tone="muted" />
        </ul>
      </div>
      <div className="panel">
        <Label className="px-6 pt-[18px] pb-1">
          <Icon name="merge" className="size-4 text-ok" />
          Ready to merge
        </Label>
        {v.readyToMerge.length ? (
          <ul>
            {v.readyToMerge.map((p) => (
              <ReadyPr key={p.url} p={p} />
            ))}
          </ul>
        ) : (
          <Empty className="px-6 pt-1 pb-5">
            When a Review finds nothing and the checks pass, the PR shows up here.
          </Empty>
        )}
      </div>
    </section>
  );
}

/** Widths for a bar filled to the nearest 10 %, spelled out so Tailwind finds them. */
const WIDTH = [
  "w-0",
  "w-1/10",
  "w-2/10",
  "w-3/10",
  "w-4/10",
  "w-5/10",
  "w-6/10",
  "w-7/10",
  "w-8/10",
  "w-9/10",
  "w-full",
];
const width = (percent: number) => WIDTH[Math.max(0, Math.min(10, Math.round(percent / 10)))];

/** REQ-003-12: used out of the limit, as pips up to 12 and as a bar above. */
function Meter({ m }: { m: MeterView }) {
  const used = Math.min(m.used, m.limit);
  const full = m.used >= m.limit;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <meter> can't hold the label and the pips; the list item carries the role
    <li
      className="grid grid-cols-[1fr_auto] items-baseline gap-x-2 gap-y-1.5 border-line border-t py-3"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={m.limit}
      aria-valuenow={m.used}
      aria-label={`${m.label}: ${m.used} of ${m.limit}`}
    >
      <span className="text-[12px] text-muted">{m.label}</span>
      <span className={`font-bold font-display text-[20px] leading-none ${full ? "text-acc-hi" : ""}`}>
        {m.used}
        <span className="font-medium text-[13px] text-faint"> / {m.limit}</span>
      </span>
      {m.limit <= 12 ? (
        <span className="col-span-full flex h-1.5 gap-[3px]">
          {Array.from({ length: m.limit }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the pips are identical and never reorder
            <i key={i} className={`flex-1 rounded-[3px] ${i < used ? "gauge" : "bg-white/7"}`} />
          ))}
        </span>
      ) : (
        <span className="col-span-full flex h-1.5 overflow-hidden rounded-[3px] bg-white/7">
          <span className={`gauge block h-full ${width((used / m.limit) * 100)}`} />
        </span>
      )}
    </li>
  );
}

const Capacity = ({ v }: { v: DashboardView }) => (
  <section id="capacity" className="wrap mt-9">
    <Label>Capacity</Label>
    <ul className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-6">
      {v.capacity.map((m) => (
        <Meter key={m.label} m={m} />
      ))}
    </ul>
  </section>
);

const ROLE_ICONS: Record<string, IconName> = { Planner: "compass", Implementer: "code", Reviewer: "eye" };

/** REQ-003-01: a card per session: what it is doing, the bar under its head, its issues and its names. */
function Session({ s }: { s: SessionView }) {
  const tone = { running: "text-acc-hi", idle: "text-white/45", gone: "text-fg" }[s.state];
  const bar = {
    running: "flowing w-full",
    idle: `bg-white/35 ${width(s.idleShare ?? 0)}`,
    gone: "bg-bad/45 w-full",
  }[s.state];
  return (
    <li className="min-w-0" data-state={s.state}>
      <div className="flex items-center gap-2.5">
        <Icon
          name={ROLE_ICONS[s.role] ?? "user"}
          className={`size-[18px] ${s.state === "running" ? "text-acc-hi" : "text-white/45"}`}
        />
        <b className="font-bold font-display text-[16px] leading-[1.3]">{s.role}</b>
        <span className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] tabular-nums ${tone}`}>
          {s.state === "running" && (
            <>
              <span className="size-1.5 animate-fade rounded-full bg-acc" />
              running
            </>
          )}
          {s.state === "idle" && `idle ${s.idleFor ?? ""} of ${s.idleTimeout}`}
          {s.state === "gone" && (
            <>
              <span className="size-1.5 rounded-full bg-bad" />
              window gone
            </>
          )}
        </span>
      </div>
      <div className="mt-2.5 h-0.5 overflow-hidden rounded-xs bg-white/7">
        <span className={`block h-full rounded-xs ${bar}`} />
      </div>
      <div className="mt-3 leading-[1.35] wrap-anywhere">
        {s.issues.map((i, n) => (
          <span key={i.url}>
            {n > 0 && ", "}
            <Link className="text-white/90" href={i.url}>
              <span className="text-white/35 tabular-nums">#{i.number}</span>
              {i.title ? ` ${i.title}` : ""}
            </Link>
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-white/40">
        <span>{s.repo}</span>
        <span className="font-mono text-[11px]">{s.model}</span>
        <span>since {s.startedAt ? formatTime(s.startedAt) : "–"}</span>
        <button
          className="ml-auto inline-flex cursor-pointer items-center gap-1.5 font-medium text-[12px] text-white/40 leading-[1.2] transition-colors hover:text-acc-hi [&.done]:text-ok"
          type="button"
          data-copy={s.name}
          hidden
        >
          <Icon name="copy" className="size-[13px]" />
          <span>Copy name</span>
        </button>
      </div>
      <code
        className="mt-1.5 block font-mono text-[11px] text-faint wrap-anywhere"
        title="Remote Control name in the Claude app"
      >
        {s.name}
      </code>
    </li>
  );
}

const Working = ({ v }: { v: DashboardView }) => (
  <section id="working">
    <Heading title="Working now" note={plural(v.sessions.length, "live session", "live sessions")} />
    {v.sessions.length ? (
      <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
        {v.sessions.map((s) => (
          <Session key={s.name} s={s} />
        ))}
      </ul>
    ) : (
      <Empty>No agent sessions are open.</Empty>
    )}
  </section>
);

/** REQ-003-16: an icon per kind of Event; the tone comes from the view. */
const EVENT_ICONS: Record<EventKind, IconName> = {
  assessed: "doc",
  approved: "check",
  blocked: "pause",
  unblocked: "bolt",
  "pr-opened": "pr",
  "review-passed": "merge",
  "review-findings": "alert",
  "feedback-round": "loop",
  failed: "cross",
};

const Event = ({ e }: { e: EventView }) => (
  <li
    className={`flex items-start gap-3 border-line border-t py-3 first:border-t-0 ${TONE_TEXT[e.tone]}`}
    data-tone={e.tone}
  >
    <Icon name={EVENT_ICONS[e.kind] ?? "dot"} className="mt-0.5 size-4" />
    <div className="min-w-0 flex-1">
      <div className="text-fg wrap-anywhere">{e.text}</div>
      <div className="mt-0.5 text-[12px] text-muted wrap-anywhere">
        <time dateTime={e.datetime} title={e.at}>
          {e.ago}
        </time>{" "}
        · {e.repo}
        {e.links.map((l) => (
          <span key={l.url}>
            {" · "}
            <Link href={l.url}>{l.label}</Link>
          </span>
        ))}
      </div>
    </div>
  </li>
);

const Recent = ({ v }: { v: DashboardView }) => (
  <section id="recent">
    <Heading title="Recent" note="newest first" />
    {v.recent.length ? (
      <ul>
        {v.recent.map((e) => (
          <Event key={`${e.datetime} ${e.text}`} e={e} />
        ))}
      </ul>
    ) : (
      <Empty>Nothing has happened yet. Events show up here once the Coordinator acts on an issue.</Empty>
    )}
  </section>
);

/** REQ-003-04: what each kind of queued work does, as a step's name and icon. */
const WORK: Record<WorkKind, { label: string; icon: IconName }> = {
  "resume-interrupted": { label: "Resume", icon: "loop" },
  feedback: { label: "Feedback", icon: "code" },
  wake: { label: "Wake", icon: "bolt" },
  review: { label: "Review", icon: "eye" },
  implement: { label: "Implement", icon: "code" },
  plan: { label: "Plan", icon: "compass" },
  revise: { label: "Revise", icon: "compass" },
};

type StepKind = "next" | "later" | "blocked";

/** One step on the pipe: a diamond node, the number and what it is; the first is "next", blocked ones are muted (REQ-003-17). */
function Step({
  n,
  kind,
  head,
  sub,
  why,
}: {
  n: number;
  kind: StepKind;
  head: [IconName, ReactNode];
  sub: ReactNode;
  why: [IconName, ReactNode];
}) {
  const first = kind === "next";
  const blocked = kind === "blocked";
  const accent = first ? "text-acc-hi" : blocked ? "text-muted" : "text-white/55";
  return (
    <li
      className="step group relative pl-8 sm:max-w-80 sm:flex-[1_0_220px] sm:snap-start sm:pt-8 sm:pr-6 sm:pl-0 sm:last:max-w-none sm:last:grow-2"
      data-step={kind}
    >
      <span
        className={`absolute top-px left-0 size-3.5 rotate-45 rounded-[3px] border-2 transition-[scale,box-shadow] duration-450 ease-calm group-hover:scale-135 group-hover:shadow-[0_0_14px_rgb(124_114_255/0.8)] ${
          first
            ? "border-acc bg-acc shadow-[0_0_16px_rgb(124_114_255/0.85)]"
            : blocked
              ? "border-white/30 bg-ink"
              : "border-acc/60 bg-ink"
        }`}
      />
      <div
        className={`min-w-0 transition-transform duration-450 ease-calm group-hover:-translate-y-0.5 ${first ? "mt-5 sm:mt-0" : ""}`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`font-bold font-display text-[14px] tabular-nums leading-none ${first ? "text-acc-hi" : "text-white/30"}`}
          >
            {String(n + 1).padStart(2, "0")}
          </span>
          <Icon name={head[0]} className={`size-4 ${accent}`} />
          <b className="font-display font-semibold text-[15px] leading-[1.3] wrap-anywhere [&_a]:text-white">
            {head[1]}
          </b>
        </div>
        <div className="mt-1 text-[13px] text-white/55 wrap-anywhere">{sub}</div>
        <div className="mt-1.5 flex items-start gap-1.5 text-[12px] text-white/40">
          <Icon name={why[0]} className="mt-px size-[13px]" />
          <span>{why[1]}</span>
        </div>
      </div>
      {first && (
        <span className="absolute -top-0.5 left-6 font-semibold text-[11px] text-acc-hi leading-none sm:-top-[22px] sm:-left-0.5">
          next
        </span>
      )}
      {blocked && (
        <span className="mt-1.5 inline-block font-semibold text-[10px] text-muted uppercase leading-none tracking-widest">
          blocked
        </span>
      )}
    </li>
  );
}

/** Up next: numbered steps on a dashed pipe, sideways on wider screens; blocked issues come last. */
function UpNext({ v }: { v: DashboardView }) {
  const steps = [
    ...v.queue.map((q, i) => {
      const w = WORK[q.kind] ?? { label: q.kind, icon: "dot" as const };
      return (
        <Step
          key={q.key}
          n={i}
          kind={i === 0 ? "next" : "later"}
          head={[w.icon, w.label]}
          sub={<span className="font-mono text-[0.86em]">{q.key}</span>}
          why={[q.waiting ? "hourglass" : "bolt", q.status]}
        />
      );
    }),
    ...v.blocked.map((b, i) => (
      <Step
        key={b.url}
        n={v.queue.length + i}
        kind="blocked"
        head={["lock", <Link key="issue" href={b.url}>{`${b.repo}#${b.number}`}</Link>]}
        sub={b.title}
        why={[
          "lock",
          <>
            blocked by{" "}
            {b.blockedBy.length
              ? b.blockedBy.map((x, n) => (
                  <span key={x.url}>
                    {n > 0 && ", "}
                    <Link href={x.url}>#{x.number}</Link>
                  </span>
                ))
              : "–"}
          </>,
        ]}
      />
    )),
  ];
  return (
    <section id="up-next" className="min-w-0">
      <Heading title="Up next" note="what the scheduler starts, in order" />
      {steps.length ? (
        <div className="thin-scroll relative sm:scroll-px-1.5 sm:snap-x sm:snap-proximity sm:overflow-x-auto sm:overscroll-x-contain sm:px-1.5 sm:pt-7 sm:pb-2">
          <ol className="relative grid gap-7 sm:flex sm:gap-0">{steps}</ol>
        </div>
      ) : (
        <Empty>Nothing is queued.</Empty>
      )}
    </section>
  );
}

/** The accent line colour of each tone in the Pipeline. */
const TONE_ACCENT: Record<Tone, string> = {
  acc: "[--accent:var(--color-acc)]",
  ok: "[--accent:var(--color-ok)]",
  warn: "[--accent:var(--color-warn)]",
  bad: "[--accent:var(--color-bad)]",
  muted: "[--accent:rgb(255_255_255/0.5)]",
};

/** An issue in the Pipeline; a hover grows its accent line in, washes the row and nudges its content (#87). */
const Item = ({ i }: { i: IssueView }) => (
  <li
    className={`group accent relative border-line border-b py-3.5 pr-1 pl-3 transition-[background] duration-600 ease-calm hover:bg-linear-to-r hover:from-acc/7 hover:to-transparent hover:to-70% ${TONE_ACCENT[i.tone]}`}
    data-tone={i.tone}
  >
    <div className="transition-transform duration-450 ease-calm group-hover:translate-x-1.5">
      <div className="flex flex-col">
        <Link className="font-medium text-fg wrap-anywhere" href={i.url}>
          {i.title}
        </Link>
        <span className="font-mono text-[11px] text-faint">
          {i.repo}#{i.number}
        </span>
      </div>
      <p className="mt-1 flex items-baseline gap-1.5 text-[12px] text-white/70">
        <span className={`size-1.5 flex-none -translate-y-px rounded-full ${TONE_BG[i.tone]}`} aria-hidden="true" />
        {i.status}
      </p>
      {i.pr && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
          <Link href={i.pr.url}>PR #{i.pr.number}</Link>
          <PrDetails p={i.pr} />
        </div>
      )}
    </div>
  </li>
);

const Column = ({ c }: { c: ColumnView }) => (
  <div className="min-w-0 snap-start">
    <h3 className="flex items-center justify-between border-line-2 border-b pb-2 font-semibold text-[13px]">
      <span>{c.title}</span>
      <Count>{c.issues.length}</Count>
    </h3>
    {c.issues.length ? (
      <ul>
        {c.issues.map((i) => (
          <Item key={i.url} i={i} />
        ))}
      </ul>
    ) : (
      <Empty>Nothing here</Empty>
    )}
  </div>
);

const Chip = ({ href, current, children }: { href: string; current: boolean; children: string }) => (
  <a
    className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] ${
      current ? "border-acc bg-acc/18 text-white" : "border-line-2 text-muted"
    }`}
    href={href}
    aria-current={current ? "true" : undefined}
  >
    {children}
  </a>
);

/** REQ-003-02: seven columns, sideways scroll with snap points; REQ-003-13: the repository filter. */
function Pipeline({ v }: { v: DashboardView }) {
  const open = v.columns.reduce((n, c) => n + c.issues.length, 0);
  return (
    <section id="pipeline" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 [&_h2]:m-0">
        <Heading title="Pipeline" note={plural(open, "open issue", "open issues")} />
        {v.repos.length > 1 && (
          <nav className="flex flex-wrap gap-1.5" aria-label="Repository">
            <Chip href="/#pipeline" current={v.repoFilter === null}>
              All
            </Chip>
            {v.repos.map((r) => (
              <Chip key={r} href={`/?repo=${encodeURIComponent(r)}#pipeline`} current={v.repoFilter === r}>
                {r}
              </Chip>
            ))}
          </nav>
        )}
      </div>
      <div className="thin-scroll grid snap-x snap-mandatory auto-cols-[82%] grid-flow-col gap-4 overflow-x-auto overscroll-x-contain pb-2.5 sm:auto-cols-[minmax(150px,1fr)]">
        {v.columns.map((c) => (
          <Column key={c.title} c={c} />
        ))}
      </div>
    </section>
  );
}

/**
 * The Overview: Summary, Capacity, Working now next to Recent, then Up next, the Pipeline and the
 * footer in the band, which grows to the bottom of a short page (#100).
 */
export const Overview = ({ v }: { v: DashboardView }) => (
  <Layout v={v} page="overview">
    <main className="flex grow flex-col">
      <div className="wrap mt-9">
        <Summary v={v} />
      </div>
      <Capacity v={v} />
      <div className="wrap mt-9 grid gap-9 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-10">
        <Working v={v} />
        <Recent v={v} />
      </div>
      <div className="band mt-4 flex grow flex-col pt-24">
        <div className="wrap grid gap-16">
          <UpNext v={v} />
          <Pipeline v={v} />
        </div>
        <Footer className="mt-auto pt-16" />
      </div>
    </main>
  </Layout>
);

export const renderDashboard = (v: DashboardView): string => renderPage(<Overview v={v} />);
