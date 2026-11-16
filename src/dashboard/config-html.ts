/**
 * The Config page (REQ-003-05): the effective settings, read-only. It renders only the allow-listed
 * `SettingsView`, so no secret reaches it.
 */
import { isLoopback } from "../config.ts";
import { empty, esc, icon, layout, plural } from "./html.ts";
import type { DashboardView, RoleView, SettingsView } from "./view.ts";

function access(s: SettingsView): string {
  const a = s.access;
  if (!a) return "";
  const loopback = isLoopback(a.host);
  const fact = (ok: boolean, text: string) =>
    `<li class="${ok ? "ok" : "warn"}">${icon(ok ? "check" : "alert")}${text}</li>`;
  return `<section id="access"><h2>Access</h2>
<ol class="path">
<li>${icon("phone")}<span>Your browser</span></li>
<li>${icon("shield")}<span>${loopback ? "Tailscale or an SSH tunnel" : "Your network"}</span></li>
<li>${icon("server")}<span>Coordinator at <code class="mono">${esc(a.host)}:${esc(a.port)}</code></span></li>
</ol>
<ul class="facts">${fact(a.tokenRequired, a.tokenRequired ? "Token required" : "No token")}${fact(true, "GET only")}${fact(
    loopback,
    loopback ? "Loopback only" : `Listens on ${esc(a.host)}`,
  )}${fact(true, "No GitHub calls")}</ul>
</section>`;
}

function limits(s: SettingsView): string {
  const all: [string, number][] = [...Object.entries(s.limits), ["checksGraceSeconds", s.checksGraceSeconds]];
  return `<section id="limits"><h2>Limits</h2><dl class="limits">${all
    .map(([k, v]) => `<div><dd>${esc(v)}</dd><dt class="mono">${esc(k)}</dt></div>`)
    .join("")}</dl></section>`;
}

function models(s: SettingsView): string {
  const row = (r: RoleView, where: string, cls = "") =>
    `<tr${cls ? ` class="${cls}"` : ""}><th scope="row">${esc(r.role)}${where ? ` <span class="muted">in ${esc(where)}</span>` : ""}</th><td class="mono">${esc(r.model)}</td><td>${esc(r.effort ?? "default")}</td></tr>`;
  const overrides = s.repos.flatMap((repo) => repo.overrides.map((r) => row(r, repo.name, "override")));
  return `<section id="models"><h2>Models</h2><table class="table"><thead><tr><th scope="col">Role</th><th scope="col">Model</th><th scope="col">Effort</th></tr></thead><tbody>${s.roles
    .map((r) => row(r, ""))
    .join("")}${overrides.join("")}</tbody></table></section>`;
}

function repos(s: SettingsView): string {
  const repo = (r: SettingsView["repos"][number]) => {
    const counts = r.counts
      ? `<ul class="r-counts"><li><b>${esc(r.counts.issues)}</b> ${r.counts.issues === 1 ? "open issue" : "open issues"}</li><li><b>${esc(
          r.counts.pulls,
        )}</b> ${r.counts.pulls === 1 ? "agent PR" : "agent PRs"}</li><li><b>${esc(r.counts.worktrees)}</b> ${
          r.counts.worktrees === 1 ? "Worktree" : "Worktrees"
        }</li></ul>`
      : `<p class="muted">No tick yet.</p>`;
    const domains = r.sandboxDomains.length
      ? r.sandboxDomains.map((d) => `<span class="chip mono">${esc(d)}</span>`).join("")
      : "–";
    return `<li class="row repo"><div class="r-name">${icon("repo")}<span class="mono">${esc(r.name)}</span></div>${counts}
<dl class="r-facts"><dt>Setup</dt><dd>${r.setup ? `<code class="mono">${esc(r.setup)}</code>` : "–"}</dd><dt>Sandbox domains</dt><dd class="chips">${domains}</dd></dl></li>`;
  };
  return `<section id="repos"><h2>Repositories <span class="count">${s.repos.length}</span></h2>${
    s.repos.length ? `<ul class="rows">${s.repos.map(repo).join("")}</ul>` : empty("No repositories configured.")
  }</section>`;
}

export function renderConfig(v: DashboardView): string {
  const s = v.settings;
  return layout(
    v,
    "config",
    `<main class="wrap config">
<section class="hero solo"><div class="hero-text"><p class="eyebrow">Config</p>
<h1>Polling ${plural(s.repos.length, "repository", "repositories")} every ${esc(s.pollIntervalSec)} s</h1>
<p class="lede">The effective settings from the config file. Read-only, and no secrets: keys and tokens are never shown.</p></div></section>
${access(s)}
${limits(s)}
<div class="split">${models(s)}${repos(s)}</div>
</main>`,
  );
}
