/**
 * Server-side HTML for the dashboard (spec 003): the shared layout and the Overview. The page reads
 * fully without JavaScript; `assets/dashboard.js` only adds the countdown, the copy buttons and the
 * background. Every value goes through `esc`, since titles and names come from GitHub and agents
 * (REQ-003-09). No inline styles or scripts: the CSP allows only same-origin files.
 */

import type { EventKind } from "../store.ts";
import { assetUrl } from "./assets.ts";
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

export const esc = (s: string | number): string =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const link = (url: string, text: string, cls = "") =>
  `<a${cls ? ` class="${cls}"` : ""} href="${esc(url)}" rel="noreferrer">${esc(text)}</a>`;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Line icons (24×24, stroked), drawn inline so they need no request and no container. */
const ICONS = {
  logo: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  lock: "M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z",
  merge: "M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
  check: "M5 12.5l4.5 4.5L19 7",
  cross: "M6 6l12 12M18 6L6 18",
  dot: "M12 12h.01",
  clock: "M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z",
  ext: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  alert: "M12 4l9 16H3l9-16zM12 10v4M12 17.5h.01",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  bolt: "M13 3L5 13h6l-1 8 8-10h-6l1-8z",
  pause: "M8 5v14M16 5v14",
  phone: "M8 2h8a1 1 0 011 1v18a1 1 0 01-1 1H8a1 1 0 01-1-1V3a1 1 0 011-1zM11 18h2",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  repo: "M5 4h11l3 3v13H5zM9 4v6l2-1.5L13 10V4",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  pr: "M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 21a3 3 0 100-6 3 3 0 000 6zM18 15V8a3 3 0 00-3-3h-4M13 3l-2 2 2 2",
  loop: "M4 12a8 8 0 0114-5.3M20 4v4h-4M20 12a8 8 0 01-14 5.3M4 20v-4h4",
} as const;
export type Icon = keyof typeof ICONS;

export const icon = (name: Icon, cls = "i") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

export const empty = (text: string) => `<p class="empty">${esc(text)}</p>`;

/** The page frame shared by the Overview and the Config page: header with tabs, countdown and alerts. */
export function layout(v: DashboardView, page: "overview" | "config", body: string): string {
  const tab = (href: string, label: string, current: boolean) =>
    `<a href="${href}"${current ? ' aria-current="page"' : ""}>${label}</a>`;
  const last = v.lastTick
    ? `Last tick ${esc(v.lastTick.at)} · ${esc(v.lastTick.ago)}`
    : "No tick has finished yet; this page reloads by itself.";
  const alerts = [
    ...(v.pausedUntil
      ? [{ icon: "pause" as const, text: `Usage limit: new work pauses until ${esc(v.pausedUntil)}.` }]
      : []),
    ...v.errors.map((e) => ({ icon: "alert" as const, text: `${esc(e.repo)}: polling failed: ${esc(e.error)}` })),
  ]
    .map((a) => `<li>${icon(a.icon)}<span>${a.text}</span></li>`)
    .join("");
  const ring = `<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="ring-bg" cx="10" cy="10" r="8"/><circle class="ring-fg" cx="10" cy="10" r="8" stroke-dasharray="50.27" stroke-dashoffset="0"/></svg>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<noscript><meta http-equiv="refresh" content="${esc(v.refreshSec)}"></noscript>
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#05060B">
<title>${page === "config" ? "Config · " : ""}Coordinator</title>
<link rel="stylesheet" href="${assetUrl("dashboard.css")}">
<script src="${assetUrl("dashboard.js")}" defer></script>
</head>
<body>
<canvas id="bg" aria-hidden="true"></canvas>
<header class="top wrap">
<a class="brand" href="/">${icon("logo")}<span>Coordinator</span></a>
<nav class="tabs" aria-label="Pages">${tab("/", "Overview", page === "overview")}${tab("/config", "Config", page === "config")}</nav>
<div class="meta">
<span class="tick" data-reload="${esc(v.refreshSec)}" title="Reloads every ${esc(v.refreshSec)} s">${ring}<span data-countdown>every ${esc(v.refreshSec)} s</span></span>
<span class="ro">${icon("lock")}Read-only</span>
</div>
</header>
<div class="wrap">
<p class="last">${icon("clock")}<span>${last}</span></p>
${alerts ? `<ul class="alerts">${alerts}</ul>` : ""}
</div>
${body}
<footer class="wrap foot">Read-only: this page changes nothing. Approve, give feedback and merge on GitHub.</footer>
</body>
</html>
`;
}

const checksText = (p: PullView): { text: string; tone: Tone; icon: Icon } => {
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

function prDetails(p: PullView): string {
  const c = checksText(p);
  const merge =
    p.mergeable === true
      ? `<span class="ok">mergeable</span>`
      : p.mergeable === false
        ? `<span class="bad">conflicts</span>`
        : `<span class="muted">mergeable?</span>`;
  return `<span class="${c.tone}">${icon(c.icon)}${c.text}</span>${merge}<span class="muted">rounds ${esc(p.feedbackRounds)}/${esc(p.maxFeedbackRounds)}</span>`;
}

function summary(v: DashboardView): string {
  const s = v.summary;
  const headline = s.ready ? `${plural(s.ready, "PR", "PRs")} ready to merge` : "Nothing to merge right now";
  const ready = v.readyToMerge.length
    ? `<ul class="rows">${v.readyToMerge
        .map((p) => {
          const c = checksText(p);
          return `<li><a class="row ready" href="${esc(p.url)}" rel="noreferrer">${icon("merge", "i ok")}<span class="r-main"><span class="r-title">${esc(p.title)}</span><span class="r-sub mono">${esc(p.repo)} #${esc(p.number)}</span></span><span class="r-chk ${c.tone}">${icon(c.icon)}${c.text}</span><span class="r-ext">GitHub${icon("ext")}</span></a></li>`;
        })
        .join("")}</ul>`
    : empty("When a Review finds nothing and the checks pass, the PR shows up here.");
  const count = (n: number, label: string, tone: Tone) =>
    `<li><b class="${n ? tone : "muted"}">${esc(n)}</b>${label}</li>`;
  return `<section id="summary" class="hero">
<div class="hero-text">
<p class="eyebrow">Overview</p>
<h1 class="${s.ready ? "has-ready" : ""}">${headline}</h1>
<ul class="counts">${count(s.working, "working", "acc")}${count(s.needYou, "need you", "warn")}${count(s.stuck, "stuck", "bad")}${count(s.queued, "queued", "muted")}</ul>
</div>
<div class="panel"><h2 class="panel-title">${icon("merge")}Ready to merge</h2>${ready}</div>
</section>`;
}

function meter(m: MeterView): string {
  const used = Math.min(m.used, m.limit);
  const full = m.used >= m.limit;
  const gauge =
    m.limit <= 12
      ? `<span class="pips">${'<i class="on"></i>'.repeat(used)}${"<i></i>".repeat(m.limit - used)}</span>`
      : `<span class="bar"><span class="fill w${Math.round((used / m.limit) * 10) * 10}"></span></span>`;
  return `<li class="meter${full ? " full" : ""}" role="meter" aria-valuemin="0" aria-valuemax="${esc(m.limit)}" aria-valuenow="${esc(m.used)}" aria-label="${esc(m.label)}: ${esc(m.used)} of ${esc(m.limit)}"><span class="m-label">${esc(m.label)}</span><span class="m-val">${esc(m.used)}<span class="m-lim"> / ${esc(m.limit)}</span></span>${gauge}</li>`;
}

const capacity = (v: DashboardView) =>
  `<section id="capacity" class="wrap"><h2>Capacity</h2><ul class="meters">${v.capacity.map(meter).join("")}</ul></section>`;

const STATE_LABEL = { running: "running", idle: "idle", gone: "window gone" } as const;

function session(s: SessionView): string {
  const issues = s.issues.map((i) => `${link(i.url, `#${i.number}`)}${i.title ? ` ${esc(i.title)}` : ""}`).join(", ");
  const meta = [
    esc(s.repo),
    `<span class="mono">${esc(s.model)}</span>`,
    `started ${s.startedAt ? esc(formatTime(s.startedAt)) : "–"}`,
    ...(s.idleFor ? [`idle for ${esc(s.idleFor)}`] : []),
  ].join(" · ");
  return `<li class="row session">
<span class="state ${s.state}"><span class="pulse"></span>${STATE_LABEL[s.state]}</span>
<div class="s-main"><div class="s-title"><b>${esc(s.role)}</b> ${issues}</div><div class="s-meta">${meta}</div></div>
<div class="s-name"><code class="mono" title="Remote Control name in the Claude app">${esc(s.name)}</code><button class="copy" type="button" data-copy="${esc(s.name)}" hidden>${icon("copy")}<span>Copy name</span></button></div>
</li>`;
}

const working = (v: DashboardView) =>
  `<section id="working"><h2>Working now <span class="count">${v.sessions.length}</span></h2>${
    v.sessions.length
      ? `<ul class="rows">${v.sessions.map(session).join("")}</ul>`
      : empty("No agent sessions are open.")
  }</section>`;

/** REQ-003-16: an icon per kind of Event; the tone comes from the view. */
const EVENT_ICONS: Record<EventKind, Icon> = {
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

function event(e: EventView): string {
  const links = e.links.map((l) => link(l.url, l.label)).join(" ");
  return `<li class="row event ${e.tone}">
${icon(EVENT_ICONS[e.kind] ?? "dot")}<div class="e-main"><div class="e-text">${esc(e.text)}</div><div class="e-meta"><time datetime="${esc(e.datetime)}" title="${esc(e.at)}">${esc(e.ago)}</time> · ${esc(e.repo)}${links ? ` · ${links}` : ""}</div></div>
</li>`;
}

const recent = (v: DashboardView) =>
  `<section id="recent"><h2>Recent</h2>${
    v.recent.length
      ? `<ul class="rows">${v.recent.map(event).join("")}</ul>`
      : empty("Nothing has happened yet. Events show up here once the Coordinator acts on an issue.")
  }</section>`;

function upNext(v: DashboardView): string {
  const steps = [
    ...v.queue.map(
      (q, i) =>
        `<li class="step${i === 0 ? " first" : ""}${q.waiting ? "" : " go"}"><span class="node"></span><div class="st-main"><div class="st-key mono">${esc(q.key)}</div><div class="st-why">${esc(q.status)}</div></div>${i === 0 ? '<span class="tag">next</span>' : ""}</li>`,
    ),
    ...v.blocked.map(
      (b) =>
        `<li class="step bad"><span class="node"></span><div class="st-main"><div class="st-key">${link(b.url, `${b.repo}#${b.number}`, "mono")} ${esc(b.title)}</div><div class="st-why">blocked by ${
          b.blockedBy.map((x) => link(x.url, `#${x.number}`)).join(", ") || "–"
        }</div></div><span class="tag">blocked</span></li>`,
    ),
  ];
  return `<section id="up-next"><h2>Up next <span class="count">${v.queue.length}</span></h2>${
    steps.length ? `<ol class="steps">${steps.join("")}</ol>` : empty("Nothing is queued.")
  }</section>`;
}

function item(i: IssueView): string {
  return `<li class="item ${i.tone}">
<div class="it-head">${link(i.url, i.title, "it-title")}<span class="it-ref mono">${esc(i.repo)}#${esc(i.number)}</span></div>
<p class="it-status">${esc(i.status)}</p>${
    i.pr ? `<div class="it-pr">${link(i.pr.url, `PR #${i.pr.number}`)}${prDetails(i.pr)}</div>` : ""
  }
</li>`;
}

const column = (c: ColumnView) =>
  `<div class="col"><h3><span>${esc(c.title)}</span><span class="count">${c.issues.length}</span></h3>${
    c.issues.length ? `<ul class="items">${c.issues.map(item).join("")}</ul>` : empty("Nothing here")
  }</div>`;

function pipeline(v: DashboardView): string {
  const chip = (href: string, label: string, current: boolean) =>
    `<a class="chip" href="${esc(href)}"${current ? ' aria-current="true"' : ""}>${esc(label)}</a>`;
  const filter =
    v.repos.length > 1
      ? `<nav class="filter" aria-label="Repository">${chip("/#pipeline", "All", v.repoFilter === null)}${v.repos
          .map((r) => chip(`/?repo=${encodeURIComponent(r)}#pipeline`, r, v.repoFilter === r))
          .join("")}</nav>`
      : "";
  return `<section id="pipeline"><div class="p-head"><h2>Pipeline</h2>${filter}</div><div class="board">${v.columns
    .map(column)
    .join("")}</div></section>`;
}

/** The Overview: Summary, Capacity, Working now next to Recent, then Up next and the Pipeline in the band. */
export function renderDashboard(v: DashboardView): string {
  return layout(
    v,
    "overview",
    `<main>
<div class="wrap">${summary(v)}</div>
${capacity(v)}
<div class="wrap duo">
${working(v)}
${recent(v)}
</div>
<div class="band"><div class="wrap band-grid">${upNext(v)}${pipeline(v)}</div></div>
</main>`,
  );
}
