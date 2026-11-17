import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import type { RepoSnapshot, TickSnapshot } from "../src/coordinator.ts";
import { asset as served } from "../src/dashboard/assets.ts";
import { renderConfig } from "../src/dashboard/config-html.tsx";
import { renderDashboard } from "../src/dashboard/html.tsx";
import { dashboardView } from "../src/dashboard/view.ts";

const config = parseConfig({
  owner: { login: "octo", id: 42 },
  pollIntervalSec: 45,
  limits: { maxWorktrees: 3 },
  roles: { planner: { model: "opus", effort: "high" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [
    { name: "octo/app", setup: "bun install", roles: { reviewer: { model: "haiku", effort: "low" } } },
    { name: "octo/lib" },
  ],
  dashboard: { host: "127.0.0.1", port: 8787, tokenPath: "/secret/dash/token" },
});
const NOW = new Date("2026-11-15T10:30:00Z");

const repo = (r: Partial<RepoSnapshot> & Pick<RepoSnapshot, "repo">): RepoSnapshot => ({
  error: null,
  issues: [],
  pulls: [],
  worktrees: 0,
  ...r,
});

const snap: TickSnapshot = {
  finishedAt: "2026-11-15T10:29:00.000Z",
  pausedUntil: null,
  repos: [
    repo({
      repo: "octo/app",
      worktrees: 1,
      issues: [
        { number: 5, title: "Fix login", labels: ["agent:reviewed"], blockedBy: [] },
        { number: 6, title: "Add search", labels: ["agent:proposed"], blockedBy: [] },
        { number: 8, title: "Waits for six", labels: ["agent:blocked"], blockedBy: [6] },
      ],
      pulls: [
        {
          number: 70,
          title: "Fix the login form",
          labels: [],
          issues: [5],
          feedbackRounds: 1,
          state: { headSha: "h", checks: "success", mergeable: true, headSeenAt: "t", state: "open" },
        },
      ],
    }),
    repo({ repo: "octo/lib", issues: [{ number: 2, title: "Lib thing", labels: [], blockedBy: [] }] }),
  ],
  sessions: [
    {
      id: 1,
      repo: "octo/app",
      role: "implementer",
      kind: "issue",
      issues: [6],
      claudeSessionId: "c",
      state: "running",
      resumeAttempts: 0,
      lastActivityAt: "2026-11-15T10:00:00.000Z",
      ownerMessagedAt: null,
      coordinatorPromptPending: false,
      resultFailures: 0,
      needsSync: false,
      usageLimited: false,
      modelId: "claude-sonnet-5-5",
      title: "Add search",
      startedAt: "2026-11-15T09:00:00.000Z",
      account: null,
      live: true,
    },
  ],
  queue: [
    { work: { key: "octo/app#6 implement", kind: "implement", role: "implementer", queuedAt: "t" } },
    {
      work: { key: "octo/lib plan", kind: "plan", role: "planner", queuedAt: "t" },
      wait: { kind: "max-running" },
    },
  ],
  events: [
    {
      at: "2026-11-15T10:25:00.000Z",
      repo: "octo/app",
      kind: "review-passed",
      issues: [5],
      pr: 70,
      text: "Review of PR #70: no findings, ready for the Owner",
    },
    {
      at: "2026-11-15T09:00:00.000Z",
      repo: "octo/lib",
      kind: "failed",
      issues: [2],
      pr: null,
      text: "#2 failed: boom",
    },
  ],
};

const overview = (opts?: { repo?: string }) => renderDashboard(dashboardView(snap, config, NOW, opts));
const configPage = () => renderConfig(dashboardView(snap, config, NOW));
/** A file as the server serves it (the stylesheet is built from its Tailwind source, REQ-003-19). */
const asset = (name: string) => new TextDecoder().decode(served(name)?.body);

/** The classes used in a page's markup. */
const classes = (html: string) =>
  new Set(
    [...html.matchAll(/ class="([^"]*)"/g)].flatMap(
      (m) => m[1]?.replaceAll("&gt;", ">").replaceAll("&amp;", "&").split(/\s+/) ?? [],
    ),
  );
/** `.cls` as it appears in a selector, e.g. `.w-\[10\%\]` for `w-[10%]`. */
const selector = (cls: string) => `.${cls.replace(/[^\w-]/g, (c) => `\\${c}`)}`;

const order = (html: string, marks: string[]) => marks.map((m) => html.indexOf(m));

/** The selectors of `targets` that sit inside an element matching `outer`. */
const inside = (html: string, outer: string, targets: string[]) => {
  let depth = 0;
  const found = new Set<string>();
  let rw = new HTMLRewriter().on(outer, {
    element(e) {
      depth++;
      e.onEndTag(() => {
        depth--;
      });
    },
  });
  for (const t of targets)
    rw = rw.on(t, {
      element() {
        if (depth > 0) found.add(t);
      },
    });
  rw.transform(html);
  return found;
};

describe("dashboard html", () => {
  test("REQ-003-11 / REQ-003-12 / REQ-003-01 / REQ-003-04 / REQ-003-02 the Overview shows its sections in order", () => {
    const html = overview();
    const at = order(html, ["PR ready to merge", "Capacity", "Working now", "Recent", "Up next", "Pipeline"]);
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // #100: the frosted band holds Up next, the Pipeline and the footer, so it runs to the bottom of the page.
    expect(inside(html, "div.band", ["#up-next", "#pipeline", "footer"])).toEqual(
      new Set(["#up-next", "#pipeline", "footer"]),
    );
    expect(html.indexOf("<footer")).toBeGreaterThan(html.indexOf('id="pipeline"'));
  });

  test("#100 the band fades in at the top only and grows to the bottom of a short page; the Config page keeps its footer", () => {
    const css = asset("dashboard.css");
    const mask = css.match(/\.band:before\s*\{[^}]*?mask-image:\s*([^;]+);/)?.[1];
    // Built and minified: transparent at the top, opaque from 72px on, and no stop that fades the bottom out.
    expect(mask).toMatch(/^linear-gradient\((?:180deg, )?(?:transparent|#0000) 0, #000 72px\)$/);
    const html = overview();
    expect(html).toMatch(/<body class="[^"]*flex-col/);
    expect(html).toMatch(/<main class="[^"]*grow[^"]*"[\s\S]*<div class="band [^"]*grow/);
    const config = configPage();
    expect(config).toContain("Read-only: this page changes nothing.");
    expect(inside(config, "main", ["footer"]).size).toBe(0);
  });

  test("REQ-003-17 red marks only failures, the attention tone only the Owner's move, and status text stays neutral", () => {
    const html = overview();
    // The fixture has a blocked issue and a failed Event: only the failed Event is red.
    const reds = [...html.matchAll(/<li [^>]*data-tone="bad"[\s\S]*?<\/li>|(?:text|bg|border)-bad\b/g)].map(
      (m) => m[0],
    );
    expect(reds).toHaveLength(1);
    expect(reds[0]).toContain("#2 failed: boom");
    const upNext = html.slice(html.indexOf('id="up-next"'), html.indexOf('id="pipeline"'));
    expect(upNext).toMatch(/data-step="blocked"[\s\S]*text-muted[^"]*">blocked</);
    // In the Pipeline the tone is a dot; the status text itself is neutral.
    const pipeline = html.slice(html.indexOf('id="pipeline"'));
    expect(pipeline).toMatch(
      /data-tone="warn"[\s\S]*?<p class="[^"]*text-white\/70[^"]*"><span class="[^"]*bg-warn[^"]*" aria-hidden="true"><\/span>Approve it, or reply to revise/,
    );
    expect(pipeline).toMatch(/data-tone="muted"[\s\S]*?bg-muted[\s\S]*?Blocked by #6/);
  });

  test("REQ-003-11 lists the ready PRs next to the headline with title, repository, number, checks and link", () => {
    const html = overview();
    const summary = html.slice(html.indexOf('id="summary"'), html.indexOf('id="capacity"'));
    expect(summary).toContain("Fix the login form");
    expect(summary).toContain("octo/app");
    expect(summary).toContain("#70");
    expect(summary).toContain("checks passed");
    expect(summary).toContain('href="https://github.com/octo/app/pull/70"');
    for (const label of ["working", "need you", "stuck", "queued"]) expect(summary).toContain(label);
    // #87: a plain headline with only the number in green, and the "Ready to merge" header over the PRs.
    expect(summary).toMatch(/<h1 class="[^"]*text-white[^"]*"><span class="text-ok">1<\/span> PR ready to merge<\/h1>/);
    expect(summary).toMatch(/<div class="panel"><h2 [^>]*>(?:(?!<\/h2>)[\s\S])*Ready to merge<\/h2>/);
    expect(asset("dashboard.css")).not.toContain("background-clip: text");
  });

  test("REQ-003-12 shows each meter as used out of the limit", () => {
    const html = overview();
    const capacity = html.slice(html.indexOf('id="capacity"'), html.indexOf('id="working"'));
    expect(capacity).toContain("Worktrees");
    expect(capacity).toMatch(/1<span[^>]*>\s*\/\s*3<\/span>/);
    expect(capacity).toContain('aria-label="Worktrees: 1 of 3"');
  });

  test("REQ-003-01 each session shows its model and its Remote Control name, with a copy button only for scripts", () => {
    const html = overview();
    expect(html).toContain("claude-sonnet-5-5");
    expect(html).toContain("#6 Add search · Implementer · app");
    expect(html).toMatch(/<button[^>]*data-copy="#6 Add search · Implementer · app"[^>]*hidden/);
  });

  test("REQ-003-16 Recent sits next to Working now: each Event with icon, tone, time and links", () => {
    const html = overview();
    expect(html).toMatch(
      /<div class="wrap [^"]*grid[^"]*"><section id="working"(?:(?!<section)[\s\S])*<\/section><section id="recent"/,
    );
    const recent = html.slice(html.indexOf('id="recent"'), html.indexOf('id="up-next"'));
    expect(recent).toMatch(
      /<li class="[^"]*text-ok" data-tone="ok"><svg [^>]*>[\s\S]*Review of PR #70: no findings, ready for the Owner/,
    );
    expect(recent).toMatch(/<li class="[^"]*text-bad" data-tone="bad"><svg [^>]*>[\s\S]*#2 failed: boom/);
    // Attribute names are case-insensitive in HTML; React writes `dateTime`.
    expect(recent).toMatch(/<time datetime="2026-11-15T10:25:00.000Z" title="2026-11-15 10:25 UTC">5 min ago<\/time>/i);
    expect(recent).toContain('href="https://github.com/octo/app/pull/70"');
    expect(recent).toContain('href="https://github.com/octo/app/issues/5"');
    expect(recent.indexOf("Review of PR #70")).toBeLessThan(recent.indexOf("#2 failed"));
    // REQ-003-13: the filter narrows it.
    const lib = overview({ repo: "octo/lib" });
    const narrowed = lib.slice(lib.indexOf('id="recent"'), lib.indexOf('id="up-next"'));
    expect(narrowed).toContain("#2 failed: boom");
    expect(narrowed).not.toContain("Review of PR #70");
  });

  test("REQ-003-04 the first step is marked next, waiting steps say why, blocked issues are marked", () => {
    const html = overview();
    const upNext = html.slice(html.indexOf('id="up-next"'), html.indexOf('id="pipeline"'));
    expect(upNext).toMatch(/octo\/app#6 implement[\s\S]*next/);
    expect(upNext).toContain("maxRunning (1) reached");
    expect(upNext).toMatch(/data-step="blocked"[\s\S]*Waits for six[\s\S]*blocked by/);
  });

  test("REQ-003-02 the Pipeline shows seven columns with counts and what each issue needs", () => {
    const html = overview();
    const pipeline = html.slice(html.indexOf('id="pipeline"'));
    for (const t of ["Intake", "Your move", "Approved", "Building", "In review", "Reviewed", "Failed"])
      expect(pipeline).toContain(`>${t}<`);
    expect(pipeline).toContain("Approve it, or reply to revise");
    expect(pipeline).toContain("rounds 1/2");
  });

  test("REQ-003-13 the repository filter is a set of plain links that marks the picked one", () => {
    const html = overview({ repo: "octo/lib" });
    expect(html).toContain('href="/?repo=octo%2Fapp#pipeline"');
    expect(html).toMatch(/<a [^>]*href="\/\?repo=octo%2Flib#pipeline"[^>]*aria-current="true"/);
    expect(html).toMatch(/<a [^>]*href="\/#pipeline">All/);
    const pipeline = html.slice(html.indexOf('id="pipeline"'));
    expect(pipeline).toContain("Lib thing");
    expect(pipeline).not.toContain("Add search");

    const single = parseConfig({ ...config, repos: [{ name: "octo/app" }], dashboard: undefined });
    expect(renderDashboard(dashboardView(snap, single, NOW))).not.toContain("?repo=");
  });

  test("REQ-003-05 the Config page shows reach, limits, models with overrides and the repositories, no secrets", () => {
    const html = configPage();
    expect(html).toContain("Polling 2 repositories every 45 s");
    expect(html).toContain("127.0.0.1:8787");
    expect(html).toContain("Token required");
    expect(html).toContain("GET only");
    expect(html).toContain("No GitHub calls");
    expect(html).toContain("maxWorktrees");
    expect(html).toMatch(/Reviewer[\s\S]*haiku[\s\S]*low/);
    expect(html).toContain("bun install");
    expect(html).not.toContain("Sandbox domains");
    expect(html).toMatch(/1<\/b>\s*Worktree/);
    expect(html).not.toContain("/secret");
    expect(html).not.toContain("app.pem");
  });

  test("REQ-003-05 both pages link to each other from the header", () => {
    for (const html of [overview(), configPage()]) {
      expect(html).toContain('href="/"');
      expect(html).toContain('href="/config"');
    }
    expect(configPage()).toMatch(/<a [^>]*href="\/config"[^>]*aria-current="page"/);
  });

  test("REQ-003-06 a countdown to the next reload, and a meta refresh for browsers without JavaScript", () => {
    const html = overview();
    expect(html).toContain('data-reload="45"');
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="45"/></noscript>');
  });

  test("REQ-003-09 both pages load only same-origin assets and have no inline scripts or styles", () => {
    for (const html of [overview(), configPage()]) {
      expect(html).not.toContain("style=");
      expect(html).not.toContain("<style");
      expect(html).not.toMatch(/<script(?![^>]*\bsrc="\/assets\/)/);
      expect(html).not.toMatch(/\b(src|href)="(https?:)?\/\/(?!github\.com\/)/);
      expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/dashboard\.css\?v=[0-9a-f]+"\/>/);
      expect(html).toMatch(/<script src="\/assets\/dashboard\.js\?v=[0-9a-f]+" defer=""><\/script>/);
    }
    expect(asset("dashboard.css")).not.toMatch(/url\((["']?)(https?:)?\/\//);
    expect(asset("dashboard.css")).not.toContain("@import");
  });

  test("REQ-003-14 the animated background shows, also for reduced motion; other animations stay off; a hidden tab pauses it", () => {
    const css = asset("dashboard.css");
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)\\s*${selector} \\{([^}]*)\\}`))?.[1] ?? "";
    // The page backdrop sits on the root, which paints below #bg (z-index: -1); a body background would cover it.
    expect(rule("html")).toContain("radial-gradient");
    expect(rule("body")).not.toContain("background");
    expect(rule("#bg")).toContain("z-index: -1");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("animation: none");
    expect(reduced).toContain("transition: none");
    expect(reduced).not.toContain("#bg");
    const js = asset("dashboard.js");
    expect(js).not.toContain("prefers-reduced-motion");
    expect(js).toContain("visibilitychange");
    expect(js).toContain('getContext("webgl"');
  });

  test("REQ-003-19 the stylesheet is built from its Tailwind source and has a rule for every class the pages use", () => {
    const css = asset("dashboard.css");
    expect(css).toContain("tailwindcss v4");
    expect(css).not.toMatch(/@(tailwind|apply|theme|source|import)\b/);
    const pages = [
      overview(),
      overview({ repo: "octo/lib" }),
      configPage(),
      renderDashboard(dashboardView(undefined, config, NOW)),
    ];
    const missing = [...new Set(pages.flatMap((html) => [...classes(html)]))].filter(
      (cls) => cls && !new RegExp(`${selector(cls).replace(/[\\.[\]()%/:]/g, "\\$&")}(?![\\w-])`).test(css),
    );
    expect(missing).toEqual([]);
  });
});
