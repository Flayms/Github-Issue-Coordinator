/**
 * Server-side HTML for the dashboard (spec 003): one mobile-first page, inline CSS, no script.
 * Every value goes through `esc`, since titles and names come from GitHub and agents (REQ-003-09).
 */
import type { DashboardView, PullView, SessionView } from "./view.ts";
import { formatTime } from "./view.ts";

export const esc = (s: string | number): string =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const link = (url: string, text: string) => `<a href="${esc(url)}" rel="noreferrer">${esc(text)}</a>`;

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1c1f24;--muted:#626a75;--line:#dde1e6;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#8d96a0;--line:#30363d;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#4493f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:12px 16px 40px}
header{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;margin-bottom:8px}
h1{font-size:20px;margin:0}
h2{font-size:16px;margin:20px 0 8px}
h3{font-size:13px;margin:0 0 6px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
a{color:var(--accent);text-decoration:none}
.muted{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px;overflow-wrap:anywhere}
.alert{border-color:var(--bad);color:var(--bad)}
.pill{display:inline-block;font-size:12px;padding:0 7px;border-radius:10px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.ok{color:var(--ok);border-color:var(--ok)}.warn{color:var(--warn);border-color:var(--warn)}.bad{color:var(--bad);border-color:var(--bad)}
ol,ul{margin:0;padding-left:20px}
li{margin:3px 0}
.cols{display:grid;gap:8px;grid-template-columns:1fr}
@media (min-width:720px){.cols{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}}
.issue{border-top:1px solid var(--line);padding:6px 0}.issue:first-of-type{border-top:0}
table{border-collapse:collapse;width:100%;font-size:14px}
td,th{text-align:left;padding:3px 8px 3px 0;vertical-align:top;border-bottom:1px solid var(--line)}
details summary{cursor:pointer;font-weight:600}
`;

const stateClass = { running: "ok", idle: "warn", gone: "bad" } as const;

function session(s: SessionView): string {
  const issues = s.issues.map((i) => `${link(i.url, `#${i.number}`)}${i.title ? ` ${esc(i.title)}` : ""}`).join(", ");
  const state = s.state === "gone" ? "window gone" : s.state;
  return `<div class="card">
<div><strong>${esc(s.role)}</strong> · ${esc(s.repo)} <span class="pill ${stateClass[s.state]}">${esc(state)}</span></div>
<div>${issues}</div>
<div class="muted">started ${s.startedAt ? esc(formatTime(s.startedAt)) : "–"}${s.idleFor ? ` · idle for ${esc(s.idleFor)}` : ""}</div>
<div class="muted">Claude app: ${esc(s.name)}</div>
</div>`;
}

function prBadges(p: PullView): string {
  const checks = p.checks ?? "unknown";
  const cls = checks === "success" ? "ok" : checks === "failure" ? "bad" : "warn";
  const merge = p.mergeable === true ? "mergeable" : p.mergeable === false ? "conflicts" : "mergeable?";
  const mcls = p.mergeable === true ? "ok" : p.mergeable === false ? "bad" : "warn";
  return `<span class="pill ${cls}">checks: ${esc(checks)}</span> <span class="pill ${mcls}">${merge}</span> <span class="pill">rounds ${esc(p.feedbackRounds)}/${esc(p.maxFeedbackRounds)}</span>`;
}

const section = (title: string, body: string) => `<h2>${esc(title)}</h2>${body}`;
const empty = (text: string) => `<p class="muted">${esc(text)}</p>`;

export function renderDashboard(v: DashboardView): string {
  const header = `<header><h1>Coordinator</h1><span class="muted">${
    v.lastTick
      ? `last tick ${esc(v.lastTick.at)} (${esc(v.lastTick.ago)})`
      : "No tick has finished yet; this page reloads by itself."
  }</span></header>`;
  const alerts = [
    ...(v.pausedUntil ? [`Usage limit: new work pauses until ${esc(v.pausedUntil)}.`] : []),
    ...v.errors.map((e) => `${esc(e.repo)}: polling failed: ${esc(e.error)}`),
  ]
    .map((a) => `<div class="card alert">${a}</div>`)
    .join("");

  const ready = v.readyToMerge.length
    ? v.readyToMerge
        .map(
          (p) =>
            `<div class="card">${link(p.url, `${p.repo}#${p.number}`)} ${esc(p.title)}<div>${prBadges(p)}</div></div>`,
        )
        .join("")
    : empty("Nothing is ready to merge.");

  const sessions = v.sessions.length ? v.sessions.map(session).join("") : empty("No agent sessions are open.");

  const queue = v.queue.length
    ? `<ol class="card">${v.queue
        .map((q) => `<li>${esc(q.key)} <span class="pill ${q.waiting ? "warn" : "ok"}">${esc(q.status)}</span></li>`)
        .join("")}</ol>`
    : empty("Nothing is queued.");
  const blocked = v.blocked.length
    ? `<div class="card"><h3>Blocked</h3><ul>${v.blocked
        .map(
          (b) =>
            `<li>${link(b.url, `${b.repo}#${b.number}`)} ${esc(b.title)} <span class="muted">blocked by ${
              b.blockedBy.map((x) => link(x.url, `#${x.number}`)).join(", ") || "–"
            }</span></li>`,
        )
        .join("")}</ul></div>`
    : "";

  const columns = v.columns.length
    ? `<div class="cols">${v.columns
        .map(
          (c) =>
            `<div class="card"><h3>${esc(c.phase)} (${c.issues.length})</h3>${c.issues
              .map(
                (i) =>
                  `<div class="issue">${link(i.url, `${i.repo}#${i.number}`)} ${esc(i.title)}${
                    i.pr ? `<div>PR ${link(i.pr.url, `#${i.pr.number}`)} ${prBadges(i.pr)}</div>` : ""
                  }</div>`,
              )
              .join("")}</div>`,
        )
        .join("")}</div>`
    : empty("No open issues in scope.");

  const s = v.settings;
  const limits = Object.entries(s.limits)
    .map(([k, val]) => `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>`)
    .join("");
  const repos = s.repos
    .map(
      (r) => `<div class="card"><h3>${esc(r.name)}</h3><table>
${r.roles.map((x) => `<tr><th>${esc(x.role)}</th><td>${esc(x.model)}${x.effort ? ` · ${esc(x.effort)}` : ""}</td></tr>`).join("")}
<tr><th>setup</th><td>${r.setup ? `<code>${esc(r.setup)}</code>` : "–"}</td></tr>
<tr><th>sandbox</th><td>${esc(r.sandboxDomains.join(", ") || "–")}</td></tr></table></div>`,
    )
    .join("");
  const settings = `<details><summary>Limits, models and repositories (read-only)</summary>
<div class="card"><table><tr><th>pollIntervalSec</th><td>${esc(s.pollIntervalSec)}</td></tr>
<tr><th>checksGraceSeconds</th><td>${esc(s.checksGraceSeconds)}</td></tr>${limits}</table></div>${repos}</details>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${esc(v.refreshSec)}">
<meta name="referrer" content="no-referrer">
<title>Coordinator</title>
<style>${CSS}</style>
</head>
<body><main>
${header}${alerts}
${section("Ready to merge", ready)}
${section("Running agents", sessions)}
${section("Planned order", queue + blocked)}
${section("Pipeline", columns)}
<h2>Settings</h2>${settings}
</main></body>
</html>
`;
}
