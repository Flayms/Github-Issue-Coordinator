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
  MoveGroup,
  MoveItem,
  MoveKind,
  NowLine,
  PullView,
  QuotaView,
  QuotaWindowView,
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

/**
 * A row of Your move (REQ-003-32), the hover of the ready PRs (#87): the green accent line grows in
 * at the left edge, a green wash, the text nudges, and the grey arrow circle turns green. From sm on
 * the row lines up with its group's name and its title and meta line take one line each, cut with an
 * ellipsis (the full title on hover); on a phone it isn't indented and the title may take 2 lines. In
 * the meta line only the repository is ever cut, never the number or a ready PR's checks fact.
 * `fade` marks the last row shown before "Show N more" (REQ-003-35).
 */
const MoveRow = ({ m, fade = false }: { m: MoveItem; fade?: boolean }) => (
  <li data-fade={fade ? "" : undefined}>
    <a
      className="group accent relative flex items-center gap-4 py-2.5 pr-[18px] pl-[18px] text-fg transition-[background] duration-600 ease-calm [--accent:var(--color-ok)] hover:bg-linear-to-r hover:from-ok/7 hover:to-transparent hover:to-70% hover:text-fg sm:pr-6 sm:pl-[52px]"
      href={m.url}
      rel="noreferrer"
    >
      <span className="flex min-w-0 flex-1 flex-col transition-transform duration-450 ease-calm group-hover:translate-x-1.5">
        <span
          className="line-clamp-2 font-display font-semibold text-[15px] text-white leading-[1.35] wrap-anywhere sm:block sm:truncate"
          title={m.title}
        >
          {m.title}
        </span>
        <span className="mt-0.5 flex min-w-0 whitespace-nowrap text-[13px] text-white/50">
          <span className="min-w-0 truncate">{m.repo}</span>
          <span className="flex-none whitespace-pre"> · {m.label}</span>
          {m.checks && (
            <span className="flex-none whitespace-pre">
              {" · "}
              <Icon name="shield" className="mr-1 size-[13px] text-ok" />
              {m.checks}
            </span>
          )}
        </span>
      </span>
      <span
        className="flex size-9 flex-none items-center justify-center rounded-full bg-white/6 text-white/70 transition-[translate,color,background-color] duration-450 ease-calm group-hover:translate-x-[3px] group-hover:-translate-y-[3px] group-hover:bg-ok group-hover:text-ink"
        title="Open on GitHub"
      >
        <Icon name="arrow" />
      </span>
    </a>
  </li>
);

/** REQ-003-32 / REQ-003-17: a bare icon per group; the PR green, Failed red, the others in the accent. */
const MOVE_ICONS: Record<MoveKind, { icon: IconName; tone: Tone }> = {
  merge: { icon: "pr", tone: "ok" },
  failed: { icon: "alert", tone: "bad" },
  questions: { icon: "user", tone: "acc" },
  approve: { icon: "doc", tone: "acc" },
  close: { icon: "cross", tone: "acc" },
};

/** A run of one group's rows; `continued` when its group started before "Show N more" (REQ-003-35). */
interface MovePart {
  group: MoveGroup;
  items: MoveItem[];
  continued: boolean;
}

/** REQ-003-35: Your move shows this many items when it holds more than `MOVES_UNCAPPED`. */
const MOVES_SHOWN = 5;
const MOVES_UNCAPPED = 6;

/** The groups' rows from item `from` up to `to`, in group order, each run marked if its group began earlier. */
function moveParts(groups: MoveGroup[], from: number, to: number): MovePart[] {
  const parts: MovePart[] = [];
  let at = 0;
  for (const group of groups) {
    const start = Math.max(from, at);
    const end = Math.min(to, at + group.items.length);
    if (start < end) parts.push({ group, items: group.items.slice(start - at, end - at), continued: start > at });
    at += group.items.length;
  }
  return parts;
}

/**
 * REQ-003-32: groups with a bare icon, name and total count, split by a plain hairline. A group
 * continued after "Show N more" has neither heading nor hairline (REQ-003-35). The `top` list starts
 * the panel: its first group has no hairline, just the panel's top padding (#154).
 */
const MoveGroups = ({
  parts,
  fadeLast = false,
  top = false,
}: {
  parts: MovePart[];
  fadeLast?: boolean;
  top?: boolean;
}) => (
  <ul>
    {parts.map(({ group: g, items, continued }, p) => {
      const { icon, tone } = MOVE_ICONS[g.kind];
      const last = p === parts.length - 1;
      return (
        <li
          key={g.kind}
          className={top && p === 0 ? "pt-1" : continued ? undefined : "border-line border-t"}
          data-move={g.kind}
        >
          {!continued && (
            <h3 className="flex items-center gap-3 px-[18px] pt-3.5 pb-1 font-semibold text-[13px] text-white/80 sm:px-6">
              <Icon name={icon} className={`size-4 ${TONE_TEXT[tone]}`} />
              {g.title}
              <span className="font-medium text-muted tabular-nums">{g.items.length}</span>
            </h3>
          )}
          <ul className="pb-2">
            {items.map((m, i) => (
              <MoveRow key={m.url} m={m} fade={fadeLast && last && i === items.length - 1} />
            ))}
          </ul>
        </li>
      );
    })}
  </ul>
);

/**
 * REQ-003-32: everything that needs the Owner. REQ-003-35: more than 6 items show the first 5 and
 * one "Show N more" for the whole panel, the rest continuing their group in place.
 */
function YourMove({ v }: { v: DashboardView }) {
  const total = v.summary.needYou;
  return (
    <div className="panel">
      {/* #154: the headline above introduces the panel; the name stays for screen readers. */}
      <h2 className="sr-only">Your move</h2>
      {total === 0 ? (
        <Empty className="px-6 pt-3 pb-5">
          Nothing needs you. A PR shows up here when its Review passes and the checks are green, an issue when the
          Planner has a plan or questions for you, or when it failed.
        </Empty>
      ) : total <= MOVES_UNCAPPED ? (
        <MoveGroups parts={moveParts(v.yourMove, 0, total)} top />
      ) : (
        <Expander
          id="moves"
          className="moves"
          more={total - MOVES_SHOWN}
          linkClassName="px-[18px] sm:px-6"
          first={<MoveGroups parts={moveParts(v.yourMove, 0, MOVES_SHOWN)} fadeLast top />}
          rest={<MoveGroups parts={moveParts(v.yourMove, MOVES_SHOWN, total)} />}
        />
      )}
    </div>
  );
}

/** REQ-003-11: a count with what it means, under the headline. */
const Stat = ({ icon, n, label, why }: { icon: IconName; n: number; label: string; why: string }) => (
  <li className="flex items-start gap-3.5 border-line border-t py-3.5">
    <Icon name={icon} className="mt-0.5 size-4 text-muted" />
    <div>
      <p className="text-[15px] text-fg">
        <b className="font-bold text-white">{n}</b> {label}
      </p>
      <p className="mt-0.5 text-[13px] text-muted">{why}</p>
    </div>
  </li>
);

/**
 * REQ-003-11: the headline with Your move (REQ-003-32) under it on the left, the explained counts with
 * Capacity (REQ-003-12) and the Usage quota (REQ-003-37) under them on the right; a phone stacks them in that order.
 */
function Summary({ v }: { v: DashboardView }) {
  const s = v.summary;
  return (
    <section id="summary" className="grid items-start gap-8 pt-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:gap-10">
      <div className="min-w-0">
        <p className="mb-2.5 font-mono font-semibold text-[12px] text-acc-hi uppercase leading-none tracking-[0.16em]">
          Overview
        </p>
        {/* Plain white, only the number in accent purple (#111: no gold on the purple page). */}
        <h1 className="mb-6 font-extrabold text-[clamp(40px,6vw,60px)] text-white leading-[1.02] tracking-[-0.03em]">
          {s.needYou ? (
            <>
              <span className="text-acc-hi">{s.needYou}</span> {s.needYou === 1 ? "thing needs" : "things need"} you
            </>
          ) : (
            "Nothing needs you right now"
          )}
        </h1>
        <YourMove v={v} />
      </div>
      <div className="min-w-0">
        <ul id="stats">
          <Stat
            icon="bolt"
            n={s.working}
            label={s.working === 1 ? "agent working" : "agents working"}
            why={s.workingLine}
          />
          <Stat
            icon="hourglass"
            n={s.queued}
            label={s.queued === 1 ? "job waiting for a slot" : "jobs waiting for a slot"}
            why={s.queued === 1 ? "Starts when a session frees up" : "Start when a session frees up"}
          />
          <Stat
            icon="pause"
            n={s.blocked}
            label="blocked"
            why={s.blocked === 1 ? "Waits for another issue to finish" : "Wait for another issue to finish"}
          />
        </ul>
        <Capacity v={v} />
        <UsageQuota v={v} />
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

/** Grid columns and spans for a meter's tube, spelled out so Tailwind finds them (index = count). */
const COLS = [
  "",
  "grid-cols-1",
  "grid-cols-2",
  "grid-cols-3",
  "grid-cols-4",
  "grid-cols-5",
  "grid-cols-6",
  "grid-cols-7",
  "grid-cols-8",
  "grid-cols-9",
  "grid-cols-10",
  "grid-cols-11",
  "grid-cols-12",
];
const SPAN = [
  "",
  "col-span-1",
  "col-span-2",
  "col-span-3",
  "col-span-4",
  "col-span-5",
  "col-span-6",
  "col-span-7",
  "col-span-8",
  "col-span-9",
  "col-span-10",
  "col-span-11",
  "col-span-12",
];
/** Slot marks are etched into the tube up to this many Slots; above it the liquid fills to the nearest tenth. */
const MAX_SLOT_MARKS = 12;

/**
 * REQ-003-24: the glass tube holding a glossy liquid, shared by Capacity and the Usage quota. The
 * tube is a grid of `cols` columns and the liquid spans the `filled` ones, so its width needs no
 * inline style (the CSP forbids them). `meters.js` draws the moving liquid into the canvas next to
 * it (REQ-003-26 stirs it); without that script the CSS liquid stays. With `marks`, a Slot mark is
 * etched per column, a little whiter over the liquid so it stays visible on it. The Timings page reuses it
 * with a `tint` per kind of step (REQ-003-45).
 */
export const Tube = ({
  cols,
  filled,
  marks,
  tint,
}: {
  cols: number;
  filled: number;
  marks: boolean;
  tint?: "checks" | "owner" | "queued";
}) => (
  <span className={`tube col-span-full grid ${COLS[cols]}`} data-tint={tint}>
    {filled > 0 && <span className={`liquid ${SPAN[filled]}`} />}
    {filled > 0 && (
      // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabindex is not focusable; the moving liquid is decoration
      <canvas className="brew" aria-hidden="true" />
    )}
    {marks && (
      <span className={`slots grid ${COLS[cols]}`}>
        {Array.from({ length: cols }, (_, i) => (
          // A mark is the left edge of its Slot: over the liquid when both Slots beside it are used.
          // biome-ignore lint/suspicious/noArrayIndexKey: the Slot marks are identical and never reorder
          <i key={i} className={i > 0 && i < filled ? "wet" : undefined} />
        ))}
      </span>
    )}
  </span>
);

/** A meter's row: the label and value over its tube. */
const METER_ROW = "grid grid-cols-[1fr_auto] items-baseline gap-x-2 gap-y-1.5 border-line border-t py-3";

/**
 * REQ-003-12, REQ-003-24: used out of the limit, in a glass tube of one column per Slot (of tenths
 * above 12 Slots, without Slot marks).
 */
function Meter({ m }: { m: MeterView }) {
  const used = Math.min(m.used, m.limit);
  const full = m.used >= m.limit;
  const marked = m.limit <= MAX_SLOT_MARKS;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <meter> can't hold the label and the tube; the list item carries the role
    <li
      className={METER_ROW}
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
      <Tube cols={marked ? m.limit : 10} filled={marked ? used : Math.round((used / m.limit) * 10)} marks={marked} />
    </li>
  );
}

/** REQ-003-12: the meters, two per row, under the counts in the Summary. */
const Capacity = ({ v }: { v: DashboardView }) => (
  <div id="capacity" className="mt-8">
    <Label>Capacity</Label>
    <ul className="grid grid-cols-2 gap-x-6">
      {v.capacity.map((m) => (
        <Meter key={m.label} m={m} />
      ))}
    </ul>
  </div>
);

const WINDOW_LABELS: Record<QuotaWindowView["label"], string> = { "5-hour": "5-hour window", weekly: "Weekly" };

/**
 * REQ-003-37: a window's percent used as a meter like Capacity's, filled to the nearest 10 % without
 * Slot marks; from 90 % the value is accent purple. Its tooltip says how old the value is. A window
 * that was never reported, or is past its reset, reads "–" with an empty tube (REQ-003-38).
 */
function QuotaMeter({ w, asOf }: { w: QuotaWindowView; asOf: string | null }) {
  const label = WINDOW_LABELS[w.label];
  const value = w.percent === null ? "–" : String(w.percent);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <meter> can't hold the label and the tube; the list item carries the role
    <li
      title={asOf ?? undefined}
      // The tube sits at the bottom, so the pair lines up when a label wraps (at 360 px).
      className={`${METER_ROW} grid-rows-[1fr_auto]`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={w.percent ?? undefined}
      aria-label={`${label}: ${value}${w.percent === null ? "" : "%"} used`}
    >
      <span className="text-[12px] text-muted">{label}</span>
      <span className={`font-bold font-display text-[20px] leading-none ${w.high ? "text-acc-hi" : ""}`}>
        {value}
        <span className="font-medium text-[13px] text-faint">{w.percent === null ? "" : "%"} used</span>
      </span>
      <Tube cols={10} filled={Math.max(0, Math.min(10, Math.round((w.percent ?? 0) / 10)))} marks={false} />
    </li>
  );
}

/**
 * REQ-003-37 / REQ-003-38: an Account's pair of meters, side by side on a phone too, with its reset
 * line under them; with several Accounts its name is a small label above. A paused Account says until
 * when instead of its meters.
 */
const AccountQuota = ({ q }: { q: QuotaView }) => (
  <div className="mt-1">
    {q.account && <p className="mt-2 font-medium text-[12px] text-fg">{q.account}</p>}
    {q.pausedUntil ? (
      <p className="border-line border-t py-3 text-[12px] text-muted" title={q.asOf ?? undefined}>
        paused until <b className="font-semibold text-fg">{q.pausedUntil}</b>
      </p>
    ) : (
      <ul className="grid grid-cols-2 gap-x-6">
        {q.windows.map((w) => (
          <QuotaMeter key={w.label} w={w} asOf={q.asOf} />
        ))}
      </ul>
    )}
    <p className="text-[12px] text-faint">{q.line}</p>
  </div>
);

/** REQ-003-37: the Usage quota under the Capacity meters, with a heading like Capacity's. REQ-003-38: the note while nothing was reported. */
const UsageQuota = ({ v }: { v: DashboardView }) => (
  <div id="usage-quota" className="mt-6 border-line border-t pt-5">
    <Label>Usage quota</Label>
    {v.usageQuota.length > 0 ? (
      v.usageQuota.map((q) => <AccountQuota key={q.account ?? ""} q={q} />)
    ) : (
      <Empty>Shown once a session has reported its usage</Empty>
    )}
  </div>
);

const ROLE_ICONS: Record<string, IconName> = { Planner: "compass", Implementer: "code", Reviewer: "eye" };

/**
 * REQ-003-42: what the agent is doing, from its transcript's tail: a label, the step's text cut to one line and
 * how long ago it happened; the whole line is the tooltip.
 */
function NowLineView({ now, running }: { now: NowLine; running: boolean }) {
  const full = [now.label, now.text, now.ago].filter(Boolean).join(" · ");
  return (
    <p className="mt-3 flex min-w-0 items-baseline gap-2 text-[12px] leading-[1.4]" data-now={now.label} title={full}>
      <span
        className={`shrink-0 rounded-xs px-1.5 py-px font-mono font-semibold text-[10px] uppercase tracking-[0.06em] ${running ? "bg-acc/15 text-acc-hi" : "bg-white/7 text-white/50"}`}
      >
        {now.label}
      </span>
      {now.text && <span className="min-w-0 truncate font-mono text-[11.5px] text-white/75">{now.text}</span>}
      <span className="shrink-0 text-white/35 tabular-nums">{now.ago}</span>
    </p>
  );
}

/**
 * REQ-003-01: a card per session: what it is doing, the bar under its head, its issues and its names.
 * An idle session says when it closes (#74); its bar shows the idle time out of `idleTimeoutMin`.
 */
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
          {s.state === "idle" && `idle · closes ${s.closesIn ?? ""}`}
          {s.state === "gone" && (
            <>
              <span className="size-1.5 rounded-full bg-bad" />
              window gone
            </>
          )}
        </span>
      </div>
      <div
        className="mt-2.5 h-0.5 overflow-hidden rounded-xs bg-white/7"
        title={s.state === "idle" ? `idle ${s.idleFor ?? ""} of ${s.idleTimeout}` : undefined}
      >
        <span className={`block h-full rounded-xs ${bar}`} />
      </div>
      {s.now && <NowLineView now={s.now} running={s.state === "running"} />}
      <div className={`${s.now ? "mt-2" : "mt-3"} leading-[1.35] wrap-anywhere`}>
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
        <span className="font-mono text-[11px]" title={s.model}>
          {s.modelName}
        </span>
        <span>since {s.startedAt ? formatTime(s.startedAt) : "–"}</span>
        {/* REQ-003-43: Open chat and Copy name (shown only with JavaScript) sit on the right and wrap together. */}
        <span className="ml-auto inline-flex items-center gap-3">
          {s.chatUrl && (
            <a
              className="inline-flex items-center gap-1.5 font-medium text-[12px] text-acc-hi leading-[1.2] transition-colors hover:text-white"
              href={s.chatUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="The whole chat in the Claude app (Remote Control), where you can write to the agent"
            >
              <Icon name="arrow" className="size-[13px]" />
              <span>Open chat</span>
            </a>
          )}
          <button
            className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-[12px] text-white/40 leading-[1.2] transition-colors hover:text-acc-hi [&.done]:text-ok"
            type="button"
            data-copy={s.name}
            hidden
          >
            <Icon name="copy" className="size-[13px]" />
            <span>Copy name</span>
          </button>
        </span>
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

/**
 * REQ-003-20: one part of the Activity timeline, its head a dot on the timeline and its title; Now's dot
 * glows as the current part (#146: no second label repeating the title). `className` places it: Now, Next, Recent on a phone, time order from lg on.
 */
function Phase({
  id,
  title,
  current = false,
  className,
  children,
}: {
  id: string;
  title: string;
  current?: boolean;
  className: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`min-w-0 ${className}`}>
      <h3 className="relative mb-2 flex items-baseline gap-2.5 border-line-2 border-t pt-4 font-bold font-display text-[17px] text-white leading-tight">
        <span
          aria-hidden="true"
          className={`absolute top-0 left-0 size-2.5 -translate-y-1/2 rounded-full ${
            current ? "bg-acc shadow-[0_0_14px_rgb(124_114_255/0.85)]" : "border-2 border-white/30 bg-ink"
          }`}
        />
        {title}
      </h3>
      {children}
    </section>
  );
}

/** How many items Recent, Now and Next each show before the expander, at every width (REQ-003-23). */
const SHOWN = 5;

/**
 * REQ-003-23, REQ-003-35: what shows at first, then "Show N more"; open, the rest shows in place with
 * "Show less" under it. A checkbox and two labels, so it needs no script; `.capped` in the stylesheet
 * does the rest.
 */
function Expander({
  id,
  more,
  first,
  rest,
  className = "",
  linkClassName = "",
}: {
  id: string;
  more: number;
  first: ReactNode;
  rest: ReactNode;
  /** `moves`: the last row shown is marked with `data-fade` instead of being the last child (REQ-003-35). */
  className?: string;
  linkClassName?: string;
}) {
  const toggle = `${id}-more`;
  const link = `cursor-pointer py-3 font-medium text-[13px] text-acc-hi hover:underline ${linkClassName}`.trim();
  return (
    <div className={`capped ${className}`.trim()}>
      <input type="checkbox" id={toggle} className="sr-only" data-capped="toggle" aria-label={`Show ${more} more`} />
      <div data-capped="first">{first}</div>
      <div data-capped="rest">{rest}</div>
      <label data-capped="more" className={link} htmlFor={toggle}>
        Show {more} more
      </label>
      <label data-capped="less" className={link} htmlFor={toggle}>
        Show less
      </label>
    </div>
  );
}

/**
 * REQ-003-23: the first five items of a part of Activity, the last of them fading out, and "Show N
 * more" under them; open, the rest show in place, in the same list and row style. Five or fewer:
 * just the list.
 */
function Capped({ id, items, list }: { id: string; items: ReactNode[]; list: (items: ReactNode[]) => ReactNode }) {
  const more = items.slice(SHOWN);
  if (!more.length) return list(items);
  return <Expander id={id} more={more.length} first={list(items.slice(0, SHOWN))} rest={list(more)} />;
}

/** REQ-003-01: the open sessions, running ones first; idle ones say they wait, not that they work (#74). */
const Now = ({ v }: { v: DashboardView }) => (
  <Phase id="now" title="Now" current className="order-1 lg:order-none">
    {v.sessions.length ? (
      <Capped
        id="now"
        items={v.sessions.map((s) => <Session key={s.name} s={s} />)}
        list={(items) => <ul className="grid gap-x-10 gap-y-8 pt-2 sm:grid-cols-2 lg:grid-cols-1">{items}</ul>}
      />
    ) : (
      <Empty>No agent sessions are open.</Empty>
    )}
  </Phase>
);

/** REQ-003-20: the row Recent and Next share: an icon, a line of text and a muted line under it. */
const Row = ({
  icon,
  className,
  data,
  sub,
  children,
}: {
  icon: IconName;
  className: string;
  data: Record<`data-${string}`, string>;
  sub: ReactNode;
  children: ReactNode;
}) => (
  <li className={`flex items-start gap-3 border-line border-t py-3 first:border-t-0 ${className}`} {...data}>
    <Icon name={icon} className="mt-0.5 size-4 flex-none" />
    <div className="min-w-0 flex-1">
      <div className="text-fg wrap-anywhere">{children}</div>
      <div className="mt-0.5 text-[12px] text-muted wrap-anywhere">{sub}</div>
    </div>
  </li>
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
  "auto-merged": "merge",
  "merge-refused": "alert",
  "feedback-round": "loop",
  failed: "cross",
};

const Event = ({ e }: { e: EventView }) => (
  <Row
    icon={EVENT_ICONS[e.kind] ?? "dot"}
    className={TONE_TEXT[e.tone]}
    data={{ "data-tone": e.tone }}
    sub={
      <>
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
      </>
    }
  >
    {e.text}
  </Row>
);

/** REQ-003-16: the newest Events, five at first and the rest behind an expander (REQ-003-23). */
const Recent = ({ v }: { v: DashboardView }) => (
  <Phase id="recent" title="Recent" className="order-3 lg:order-none">
    {v.recent.length ? (
      <Capped
        id="recent"
        items={v.recent.map((e) => <Event key={`${e.datetime} ${e.text}`} e={e} />)}
        list={(items) => <ul>{items}</ul>}
      />
    ) : (
      <Empty>Nothing has happened yet. Events show up here once the Coordinator acts on an issue.</Empty>
    )}
  </Phase>
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

const StepNumber = ({ n, first }: { n: number; first: boolean }) => (
  <span className={`mr-2 font-bold font-display text-[13px] tabular-nums ${first ? "text-acc-hi" : "text-white/30"}`}>
    {String(n + 1).padStart(2, "0")}
  </span>
);

/**
 * REQ-003-04: the queue in the scheduler's order, the first step marked "next", each with why it
 * waits; blocked issues come last and are muted (REQ-003-17). A plain list in the row style of Recent,
 * five steps at first (REQ-003-23).
 */
function Next({ v }: { v: DashboardView }) {
  const steps = [
    ...v.queue.map((q, i) => {
      const w = WORK[q.kind] ?? { label: q.kind, icon: "dot" as const };
      const first = i === 0;
      return (
        <Row
          key={q.key}
          icon={w.icon}
          className={first ? "text-acc-hi" : "text-white/55"}
          data={{ "data-step": first ? "next" : "later" }}
          sub={
            <span className="inline-flex items-start gap-1.5">
              <Icon name={q.waiting ? "hourglass" : "bolt"} className="mt-px size-[13px] flex-none" />
              {q.status}
            </span>
          }
        >
          <StepNumber n={i} first={first} />
          <b className="font-display font-semibold">{w.label}</b>{" "}
          <span className="font-mono text-[0.86em] text-white/70">{q.key}</span>
          {first && <span className="ml-2 font-semibold text-[11px] text-acc-hi">next</span>}
        </Row>
      );
    }),
    ...v.blocked.map((b, i) => (
      <Row
        key={b.url}
        icon="lock"
        className="text-muted"
        data={{ "data-step": "blocked" }}
        sub={
          <>
            <span className="mr-2 font-semibold text-[10px] text-muted uppercase tracking-widest">blocked</span>
            blocked by{" "}
            {b.blockedBy.length
              ? b.blockedBy.map((x, n) => (
                  <span key={x.url}>
                    {n > 0 && ", "}
                    <Link href={x.url}>#{x.number}</Link>
                  </span>
                ))
              : "–"}
          </>
        }
      >
        <StepNumber n={v.queue.length + i} first={false} />
        <Link className="font-display font-semibold text-white" href={b.url}>{`${b.repo}#${b.number}`}</Link>{" "}
        <span className="text-white/70">{b.title}</span>
      </Row>
    )),
  ];
  return (
    <Phase id="next" title="Next" className="order-2 lg:order-none">
      {steps.length ? (
        <Capped id="next" items={steps} list={(items) => <ol>{items}</ol>} />
      ) : (
        <Empty>Nothing is queued.</Empty>
      )}
    </Phase>
  );
}

/**
 * REQ-003-20: Recent, Now and Next as past, present and future of the same work, under one header
 * with the counts: side by side in time order from lg on, joined by the timeline, stacked Now,
 * Next, Recent on a phone.
 */
function Activity({ v }: { v: DashboardView }) {
  const idle = v.sessions.filter((s) => s.state === "idle").length;
  return (
    <section id="activity" className="wrap mt-9">
      <Heading title="Activity" note={`${v.summary.working} running · ${idle} idle · ${v.summary.queued} queued`} />
      <div className="timeline grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
        <Recent v={v} />
        <Now v={v} />
        <Next v={v} />
      </div>
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

/**
 * An issue in the Pipeline; a hover grows its accent line in, washes the row and nudges its content
 * (#87). The card clips its own sideways overflow, so the nudge never widens the Pipeline (REQ-003-02, #121).
 */
const Item = ({ i }: { i: IssueView }) => (
  <li
    className={`group accent relative overflow-x-clip border-line border-b py-3.5 pr-1 pl-3 transition-[background] duration-600 ease-calm hover:bg-linear-to-r hover:from-acc/7 hover:to-transparent hover:to-70% ${TONE_ACCENT[i.tone]}`}
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
 * The Overview: Summary (with Capacity), Activity (REQ-003-20), then the Pipeline and the footer in the
 * band, which grows to the bottom of a short page (#100).
 */
export const Overview = ({ v }: { v: DashboardView }) => (
  <Layout v={v} page="overview">
    <main className="flex grow flex-col">
      <div className="wrap mt-9">
        <Summary v={v} />
      </div>
      <Activity v={v} />
      <div className="band mt-12 flex grow flex-col pt-24">
        <div className="wrap">
          <Pipeline v={v} />
        </div>
        <Footer className="mt-auto pt-16" />
      </div>
    </main>
  </Layout>
);

export const renderDashboard = (v: DashboardView): string => renderPage(<Overview v={v} />);
