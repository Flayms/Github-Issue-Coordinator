import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import type { RepoSnapshot, TickSnapshot } from "../src/coordinator.ts";
import { asset as served } from "../src/dashboard/assets.ts";
import { renderConfig } from "../src/dashboard/config-html.tsx";
import { renderDashboard } from "../src/dashboard/html.tsx";
import { timingsView } from "../src/dashboard/timings.ts";
import { renderTimings } from "../src/dashboard/timings-html.tsx";
import { dashboardView } from "../src/dashboard/view.ts";
import { MOCK_TIMING_SOURCE } from "./fixtures/dashboard-mock.ts";

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
  accounts: [],
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
const timingsPage = () =>
  renderTimings(
    dashboardView(snap, config, NOW),
    timingsView({ source: MOCK_TIMING_SOURCE, pick: null, includeOwner: false, now: NOW }),
  );
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
  test("REQ-003-11 / REQ-003-12 / REQ-003-20 / REQ-003-02 the Overview shows its sections in order", () => {
    const html = overview();
    const at = order(html, [
      "things need you",
      "Your move",
      "Capacity",
      'id="activity"',
      'id="recent"',
      'id="now"',
      'id="next"',
      'id="pipeline"',
    ]);
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // REQ-003-20: Recent, Now and Next are parts of Activity.
    expect(inside(html, "section#activity", ["#recent", "#now", "#next", "#pipeline"])).toEqual(
      new Set(["#recent", "#now", "#next"]),
    );
    // #100 / REQ-003-20: the frosted band holds only the Pipeline and the footer, so it runs to the bottom of the page.
    expect(inside(html, "div.band", ["#activity", "#next", "#pipeline", "footer"])).toEqual(
      new Set(["#pipeline", "footer"]),
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
    const upNext = html.slice(html.indexOf('id="next"'), html.indexOf('id="pipeline"'));
    expect(upNext).toMatch(/data-step="blocked"[\s\S]*text-muted[^"]*">blocked</);
    // In the Pipeline the tone is a dot; the status text itself is neutral.
    const pipeline = html.slice(html.indexOf('id="pipeline"'));
    expect(pipeline).toMatch(
      /data-tone="warn"[\s\S]*?<p class="[^"]*text-white\/70[^"]*"><span class="[^"]*bg-warn[^"]*" aria-hidden="true"><\/span>Approve it, or reply to revise/,
    );
    expect(pipeline).toMatch(/data-tone="muted"[\s\S]*?bg-muted[\s\S]*?Blocked by #6/);
  });

  /** The Summary's markup: from its section to Capacity. */
  const summaryOf = (html: string) => html.slice(html.indexOf('id="summary"'), html.indexOf('id="capacity"'));

  test("REQ-003-11 the headline says how many things need the Owner, in accent purple, with three explained counts", () => {
    const summary = summaryOf(overview());
    // The fixture: PR #70 is ready to merge, #6 waits for approval.
    expect(summary).toMatch(
      /<h1 class="[^"]*text-white[^"]*"><span class="text-acc-hi">2<\/span> things need you<\/h1>/,
    );
    for (const [n, label, why] of [
      [1, "agent working", "Implementer running now"],
      [1, "job waiting for a slot", "Starts when a session frees up"],
      [1, "blocked", "Waits for another issue to finish"],
    ])
      expect(summary).toMatch(new RegExp(`<b[^>]*>${n}</b> ${label}</[^>]+>[\\s\\S]*?${why}`));
    // The old row of bare counts is gone, and so is the Ready to merge panel.
    expect(summary).not.toContain("stuck");
    expect(summary).not.toContain("Ready to merge");
    expect(asset("dashboard.css")).not.toContain("background-clip: text");
  });

  test("REQ-003-11 one thing needs the Owner, or nothing", () => {
    const one = summaryOf(
      renderDashboard(
        dashboardView(
          {
            ...snap,
            repos: [
              repo({
                repo: "octo/app",
                issues: [{ number: 6, title: "A", labels: ["agent:proposed"], blockedBy: [] }],
              }),
            ],
          },
          config,
          NOW,
        ),
      ),
    );
    expect(one).toContain('<span class="text-acc-hi">1</span> thing needs you</h1>');
    const none = summaryOf(renderDashboard(dashboardView({ ...snap, repos: [] }, config, NOW)));
    expect(none).toMatch(/<h1 [^>]*>Nothing needs you right now<\/h1>/);
  });

  test("REQ-003-32 Your move lists the groups with an icon, a name and a count, each row linked with title, repository and number", () => {
    const summary = summaryOf(overview());
    // #154: no visible title, the headline introduces the panel; screen readers still name it.
    expect(summary).toMatch(
      /<div class="panel[^"]*"><h2 class="sr-only">Your move<\/h2><ul><li [^>]*data-move="merge"/,
    );
    const groups = [...summary.matchAll(/<li [^>]*data-move="(\w+)"/g)].map((m) => m[1]);
    expect(groups).toEqual(["merge", "approve"]);
    expect(summary).toMatch(/data-move="merge"[\s\S]*?<h3[^>]*>[\s\S]*?Merge PRs[\s\S]*?>1<[\s\S]*?<\/h3>/);
    expect(summary).toMatch(/data-move="approve"[\s\S]*?<h3[^>]*>[\s\S]*?Approve plans[\s\S]*?>1<[\s\S]*?<\/h3>/);
    const pr = summary.slice(summary.indexOf('href="https://github.com/octo/app/pull/70"'));
    expect(pr).toMatch(/^[^>]*>[\s\S]*?Fix the login form[\s\S]*?octo\/app[\s\S]*?PR #70[\s\S]*?checks passed/);
    expect(summary).toContain('href="https://github.com/octo/app/issues/6"');
  });

  test("REQ-003-32 a row's title and meta line take one line each from sm on, with the full title on hover and no hint", () => {
    const summary = summaryOf(overview());
    const row = (href: string) => {
      const at = summary.indexOf(`href="${href}"`);
      return summary.slice(at, summary.indexOf("</a>", at));
    };
    const pr = row("https://github.com/octo/app/pull/70");
    const issue = row("https://github.com/octo/app/issues/6");
    // The hint is gone: the group name already says what to do.
    expect(summary).not.toContain("Reviewed: merge it");
    expect(summary).not.toContain("Assessment ready: approve or reply");
    for (const [r, title] of [
      [pr, "Fix the login form"],
      [issue, "Add search"],
    ] as const) {
      const t = r.match(/<span class="([^"]*)" title="([^"]*)">([^<]*)<\/span>/);
      expect(t?.[2]).toBe(title);
      expect(t?.[3]).toBe(title);
      // Up to 2 lines on a phone, one line cut with an ellipsis from sm on.
      expect(t?.[1]?.split(" ")).toEqual(expect.arrayContaining(["line-clamp-2", "sm:block", "sm:truncate"]));
    }
    // The meta line is one line: only the repository shrinks and is cut, never the number or the checks fact.
    const meta = pr.match(/<span class="([^"]*)"><span class="([^"]*)">octo\/app<\/span>/);
    expect(meta?.[1]?.split(" ")).toEqual(expect.arrayContaining(["flex", "whitespace-nowrap"]));
    expect(meta?.[2]?.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(pr).toMatch(/<span class="[^"]*flex-none[^"]*">[^<]*PR #70<\/span>/);
    expect(pr).toMatch(/<span class="[^"]*flex-none[^"]*">[^<]*<svg[\s\S]*?<\/svg>checks passed<\/span>/);
    expect(issue).toMatch(/<span class="[^"]*flex-none[^"]*">[^<]*#6<\/span>/);
  });

  test("REQ-003-32 a ready PR keeps its checks fact at every width, with a green shield", () => {
    const summary = summaryOf(overview());
    const row = summary.slice(
      summary.indexOf('href="https://github.com/octo/app/pull/70"'),
      summary.indexOf("</a>", summary.indexOf('href="https://github.com/octo/app/pull/70"')),
    );
    // The checks fact is not inside the hidden hint, and its shield is green (REQ-003-17).
    const fact = row.match(
      /<span class="([^"]*)">( · )?<svg class="([^"]*)"[^>]*><path[^>]*><\/path><\/svg>checks passed<\/span>/,
    );
    expect(fact).not.toBeNull();
    expect(fact?.[1]?.split(" ")).not.toContain("hidden");
    expect(fact?.[3]?.split(" ")).toContain("text-ok");
    expect(row).not.toMatch(/class="[^"]*\bhidden\b/);
    // Issue rows have no checks fact.
    const issue = summary.slice(summary.indexOf('href="https://github.com/octo/app/issues/6"'));
    expect(issue.slice(0, issue.indexOf("</a>"))).not.toContain("checks");
  });

  test("REQ-003-32 every row has the ready-PR hover: the green accent line, a green wash, a nudge and the arrow turning green", () => {
    const summary = summaryOf(overview());
    const rows = [...summary.matchAll(/<a class="([^"]*)" href="https:\/\/github.com[^"]*"/g)].map((m) => m[1] ?? "");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      for (const cls of ["group", "accent", "relative", "[--accent:var(--color-ok)]", "hover:from-ok/7"])
        expect(row.split(" ")).toContain(cls);
    }
    expect(summary.match(/group-hover:translate-x-1\.5/g)).toHaveLength(2);
    expect(summary.match(/rounded-full bg-white\/6[^"]*group-hover:bg-ok group-hover:text-ink/g)).toHaveLength(2);
  });

  test("REQ-003-32 / REQ-003-17 the PR icon is green, Failed red, the others in the accent, no gold, and groups split by a hairline only", () => {
    const issue = (number: number, label: string) => ({ number, title: `I${number}`, labels: [label], blockedBy: [] });
    const app = snap.repos.find((r) => r.repo === "octo/app") ?? repo({ repo: "octo/app" });
    const html = renderDashboard(
      dashboardView(
        {
          ...snap,
          repos: [
            {
              ...app,
              issues: [
                ...app.issues,
                issue(9, "agent:failed"),
                issue(10, "agent:needs-refinement"),
                issue(11, "agent:wontfix-proposed"),
              ],
            },
          ],
        },
        config,
        NOW,
      ),
    );
    const summary = summaryOf(html);
    const head = (kind: string) =>
      summary.match(new RegExp(`data-move="${kind}"[^>]*>\\s*<h3[\\s\\S]*?</h3>`))?.[0] ?? "";
    const icon = (kind: string) =>
      head(kind)
        .match(/<svg class="([^"]*)"/)?.[1]
        ?.split(" ") ?? [];
    expect(icon("merge")).toContain("text-ok");
    expect(icon("failed")).toContain("text-bad");
    for (const kind of ["questions", "approve", "close"]) expect(icon(kind)).toContain("text-acc-hi");
    expect([...summary.matchAll(/data-move="(\w+)"/g)].map((m) => m[1])).toEqual([
      "merge",
      "failed",
      "questions",
      "approve",
      "close",
    ]);
    expect(summary).toContain("Close?");
    expect(summary).not.toMatch(/\b(?:text|bg|border|from)-warn\b/);
    // Bare icons: no circle or box around them; the groups are split by a plain hairline.
    expect(head("merge")).not.toMatch(/rounded|bg-/);
    // A hairline splits the groups; the first one starts the panel, with no line against its top edge (#154).
    const groupClasses = [...summary.matchAll(/<li class="([^"]*)" data-move=/g)].map((m) => m[1]);
    expect(groupClasses).toEqual(["pt-1", ...Array(4).fill("border-line border-t")]);
  });

  test("REQ-003-32 with nothing to do Your move says so and when items will appear", () => {
    const summary = summaryOf(renderDashboard(dashboardView({ ...snap, repos: [] }, config, NOW)));
    // #154: the empty text is the first thing seen in the panel, under the hidden name.
    expect(summary).toMatch(/<div class="panel[^"]*"><h2 class="sr-only">Your move<\/h2><p [^>]*>Nothing needs you\. /);
    expect(summary).toMatch(/Nothing needs you\. [^<]*Review passes[^<]*Planner/);
    expect(summary).not.toContain("data-move=");
  });

  /** A tick whose Your move holds `failed` failed issues, then `proposed` plans to approve. */
  const moves = (failed: number, proposed: number) => {
    const issue = (number: number, label: string) => ({ number, title: `I${number}`, labels: [label], blockedBy: [] });
    return renderDashboard(
      dashboardView(
        {
          ...snap,
          repos: [
            repo({
              repo: "octo/app",
              issues: [
                ...Array.from({ length: failed }, (_, i) => issue(100 + i, "agent:failed")),
                ...Array.from({ length: proposed }, (_, i) => issue(200 + i, "agent:proposed")),
              ],
            }),
          ],
        },
        config,
        NOW,
      ),
    );
  };
  /** The Your move panel's markup. */
  const yourMoveOf = (html: string) => {
    const summary = summaryOf(html);
    return summary.slice(summary.indexOf('<div class="panel'), summary.indexOf('id="stats"'));
  };
  const rowsIn = (part: string) =>
    [...part.matchAll(/href="https:\/\/github.com\/octo\/app\/issues\/(\d+)"/g)].map((m) => Number(m[1]));

  test('REQ-003-35 with 11 items Your move shows the first 5 in group order and one "Show 6 more" for the whole panel', () => {
    const panel = yourMoveOf(moves(3, 8));
    const c = expectExpander(panel, 6);
    expect(panel.match(/data-capped="toggle"/g)).toHaveLength(1);
    expect(rowsIn(c.shown)).toEqual([100, 101, 102, 200, 201]);
    expect(rowsIn(c.rest)).toEqual([202, 203, 204, 205, 206, 207]);
    // The counts stay the totals: the headline and each group.
    expect(moves(3, 8)).toMatch(/<span class="text-acc-hi">11<\/span> things need you/);
    expect(c.shown).toMatch(/Failed<span[^>]*>3<\/span>/);
    expect(c.shown).toMatch(/Approve plans<span[^>]*>8<\/span>/);
    // The 5th row fades while the rest is closed.
    expect(c.shown.match(/data-fade/g)).toHaveLength(1);
    expect(c.shown.slice(c.shown.indexOf("data-fade"))).toContain("issues/201");
  });

  test("REQ-003-35 a group split by the cap continues in the rest without repeating its heading", () => {
    const c = capped(yourMoveOf(moves(3, 8)));
    expect(c.shown.match(/Approve plans/g)).toHaveLength(1);
    expect(c.rest).not.toContain("Approve plans");
    expect(c.rest).not.toContain("<h3");
    // The continued group has no hairline of its own.
    expect(c.rest).toMatch(/<li data-move="approve"/);
    // A group that starts after the cap brings its heading along.
    const later = capped(yourMoveOf(moves(5, 3)));
    expect(rowsIn(later.shown)).toEqual([100, 101, 102, 103, 104]);
    expect(later.rest).toMatch(/<li class="border-line border-t" data-move="approve"><h3[\s\S]*?Approve plans/);
    expect(later.shown).not.toContain("Approve plans");
  });

  test('REQ-003-35 with 6 items or fewer all show and there is no expander, never a "Show 1 more"', () => {
    for (const [failed, proposed] of [
      [3, 3],
      [0, 5],
    ] as const) {
      const panel = yourMoveOf(moves(failed, proposed));
      expect(panel).not.toContain("data-capped");
      expect(panel).not.toContain("data-fade");
      expect(rowsIn(panel)).toHaveLength(failed + proposed);
    }
  });

  test("REQ-003-35 the 5th row fades out only while the rest is closed", () => {
    const css = asset("dashboard.css").replace(/\s*([>~])\s*/g, "$1");
    expect(css).toMatch(
      /\.capped>:not\(:checked\)~\[data-capped="?first"?\] \[data-fade\][^{]*\{[^}]*mask-image:\s*linear-gradient\([^;]*(?:transparent|#0000)/,
    );
  });

  test("REQ-003-11 / REQ-003-12 Your move sits under the headline on the left, the counts with Capacity under them on the right", () => {
    const html = overview();
    // Capacity is no longer its own section after the Summary: it sits in it, under the counts.
    expect(html).not.toMatch(/<section id="capacity"/);
    expect(inside(html, "section#summary", ["#capacity", "#stats", ".panel"])).toEqual(
      new Set(["#capacity", "#stats", ".panel"]),
    );
    const summary = html.slice(html.indexOf('id="summary"'), html.indexOf('id="activity"'));
    // Two columns from md on, the left one wider; in page order (a phone stacks them): headline, Your move, counts, Capacity.
    expect(summary).toMatch(/^id="summary" class="[^"]*md:grid-cols-\[minmax\(0,3fr\)_minmax\(0,2fr\)\]/);
    const at = order(summary, ["<h1", 'class="panel', 'id="stats"', 'id="capacity"']);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(inside(html, "section#summary > div:first-child", ["h1", ".panel", "#stats"])).toEqual(
      new Set(["h1", ".panel"]),
    );
    // Two meters per row.
    expect(summary).toMatch(/id="capacity"[\s\S]*?<ul class="grid grid-cols-2 /);
  });

  test("REQ-003-12 shows each meter as used out of the limit", () => {
    const html = overview();
    const capacity = html.slice(html.indexOf('id="capacity"'), html.indexOf('id="activity"'));
    expect(capacity).toContain("Worktrees");
    expect(capacity).toMatch(/1<span[^>]*>\s*\/\s*3<\/span>/);
    expect(capacity).toContain('aria-label="Worktrees: 1 of 3"');
  });

  describe("Usage quota", () => {
    const base = dashboardView(snap, config, NOW);
    const one = {
      account: null,
      pausedUntil: null,
      windows: [
        { label: "5-hour" as const, percent: 38, high: false },
        { label: "weekly" as const, percent: 92, high: true },
      ],
      line: "Claude subscription · resets in 3 h 12 min and Fri 09:00 UTC",
      asOf: "as of 4 min ago",
    };
    const page = (usageQuota: (typeof base)["usageQuota"]) => {
      const html = renderDashboard({ ...base, usageQuota });
      return { html, section: html.slice(html.indexOf('id="usage-quota"'), html.indexOf('id="activity"')) };
    };
    const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

    test("REQ-003-37 a Usage quota heading under the Capacity meters, styled like Capacity's", () => {
      const { html } = page([one]);
      expect(inside(html, "section#summary", ["#usage-quota"])).toEqual(new Set(["#usage-quota"]));
      const at = order(html, ['id="capacity"', 'id="usage-quota"', 'id="activity"']);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      const heading = (id: string) => html.slice(html.indexOf(`id="${id}"`)).match(/<h2 class="([^"]*)"/)?.[1];
      const style = (c: string | undefined) => c?.split(" ").filter((x) => !/^(md:)?mb-/.test(x));
      expect(style(heading("usage-quota"))).toEqual(style(heading("capacity")));
      expect(html).toMatch(/id="usage-quota"[\s\S]*?<h2[^>]*>Usage quota<\/h2>/);
    });

    /** The quota meters of a section: label, value text, tube columns, liquid span and the tooltip. */
    const meters = (section: string) =>
      [...section.matchAll(/<li title="([^"]*)" class="([^"]*)" role="meter"([^>]*)>([\s\S]*?)<\/li>/g)].map(
        ([, title, cls, attrs, body]) => ({
          title,
          cls,
          attrs,
          body: body ?? "",
          text: text(body ?? "").trim(),
          tube: body?.match(/<span class="tube ([^"]*)">/)?.[1],
          liquid: body?.match(/<span class="liquid ([^"]*)"/)?.[1],
        }),
      );

    test("REQ-003-37 two meters per Account in the Capacity tube, filled to the nearest 10 %, with the percent used", () => {
      const { section } = page([one]);
      const [five, week] = meters(section);
      expect(meters(section)).toHaveLength(2);
      expect(five?.text).toBe("5-hour window38% used");
      expect(week?.text).toBe("Weekly92% used");
      // The same glass tube and liquid as Capacity (REQ-003-24): tenths, no Slot marks, a canvas for the moving liquid.
      for (const m of [five, week]) {
        expect(m?.tube).toContain("grid-cols-10");
        expect(m?.body).toContain('<canvas class="brew" aria-hidden="true"></canvas>');
        expect(m?.body).not.toContain('class="slots');
      }
      expect(five?.liquid).toBe("col-span-4");
      expect(week?.liquid).toBe("col-span-9");
      expect(five?.attrs).toContain('aria-valuemin="0" aria-valuemax="100" aria-valuenow="38"');
      expect(five?.attrs).toContain('aria-label="5-hour window: 38% used"');
      // Laid out like Capacity: side by side, on a phone too.
      expect(section).toMatch(/<ul class="grid grid-cols-2 gap-x-6">\s*<li title=/);
      const capacityLi = renderDashboard(base).match(/<li class="([^"]*)" role="meter"/)?.[1];
      expect((five?.cls ?? "").split(" ")).toEqual(expect.arrayContaining(capacityLi?.split(" ") ?? ["?"]));
      // Each tube at the bottom of its row, so the pair lines up when a label wraps.
      expect(five?.cls).toContain("grid-rows-[1fr_auto]");
      // The old pill and violet bars are gone.
      expect(section).not.toContain("quota-bar");
      expect(section).not.toContain("rounded-full border");
    });

    test("REQ-003-37 from 90 % the value is accent purple, never gold; the reset line under the meters, the age as tooltip", () => {
      const { section } = page([one]);
      const [five, week] = meters(section);
      expect(five?.body).toMatch(/<span class="[^"]*font-display[^"]*">38<span/);
      expect(five?.body).not.toContain("text-acc-hi");
      expect(week?.body).toMatch(/<span class="[^"]*font-display[^"]*text-acc-hi[^"]*">92<span/);
      expect(section).not.toMatch(/warn/);
      expect(five?.title).toBe("as of 4 min ago");
      expect(week?.title).toBe("as of 4 min ago");
      const line = section.indexOf("Claude subscription · resets in 3 h 12 min and Fri 09:00 UTC");
      expect(line).toBeGreaterThan(section.lastIndexOf('role="meter"'));
    });

    test("REQ-003-38 several Accounts: the name above each pair; a paused one says until when; – for a missing window", () => {
      const { section } = page([
        { ...one, account: "main", pausedUntil: "14:30 UTC", line: "main · resets in 3 h 12 min" },
        {
          ...one,
          account: "spare",
          windows: [
            { label: "5-hour", percent: null, high: false },
            { label: "weekly", percent: 24, high: false },
          ],
          line: "spare · resets Fri 09:00 UTC",
        },
      ]);
      expect(section).toMatch(/>main<\/p><p[^>]*>paused until <b[^>]*>14:30 UTC<\/b><\/p>/);
      // Only the spare Account has meters; its name comes before them, its line after.
      const ms = meters(section);
      expect(ms.map((m) => m.text)).toEqual(["5-hour window– used", "Weekly24% used"]);
      expect(ms[0]?.liquid).toBeUndefined();
      expect(ms[0]?.attrs).not.toContain("aria-valuenow");
      expect(ms[1]?.liquid).toBe("col-span-2");
      expect(section).toMatch(/>spare<\/p>\s*<ul class="grid grid-cols-2/);
      const order3 = ["main", "paused until", "main · resets", "spare", 'role="meter"', "spare · resets"].map((s) =>
        section.indexOf(s),
      );
      expect([...order3].sort((a, b) => a - b)).toEqual(order3);
    });

    test("REQ-003-38 a single Account has no name above its meters", () => {
      const { section } = page([one]);
      expect(section).not.toMatch(/<\/h2>\s*<div[^>]*>\s*<p/);
    });

    test("REQ-003-38 with no report the section says when it will show", () => {
      const { section } = page([]);
      expect(section).toContain("Usage quota");
      expect(text(section)).toContain("Shown once a session has reported its usage");
      expect(section).not.toContain('class="tube');
    });
  });

  describe("REQ-003-24 liquid glass meters", () => {
    /** The markup of one meter, rendered on its own in Capacity. */
    const meter = (used: number, limit: number) => {
      const html = renderDashboard({ ...dashboardView(snap, config, NOW), capacity: [{ label: "Live", used, limit }] });
      return html.slice(html.indexOf('role="meter"'), html.indexOf("</li>", html.indexOf('role="meter"')));
    };
    const liquid = (html: string) => html.match(/<span class="liquid ([^"]*)"/)?.[1];
    const slots = (html: string) =>
      html
        .match(/<span class="slots[^"]*">((?:<i(?: class="wet")?><\/i>)*)<\/span>/)?.[1]
        ?.replaceAll(' class="wet"', "").length;
    const slotMarks = (html: string) =>
      [...(html.match(/<span class="slots[^"]*">(.*?)<\/span>/)?.[1] ?? "").matchAll(/<i(?: class="(\w+)")?>/g)].map(
        (m) => m[1] ?? "",
      );

    test("the liquid fills used out of the limit inside a glass tube, with Slot marks etched in up to 12", () => {
      const live = meter(4, 5);
      expect(live).toMatch(/<span class="tube [^"]*grid-cols-5[^"]*">/);
      expect(liquid(live)).toBe("col-span-4");
      expect(slots(live)).toBe("<i></i>".length * 5);
      expect(live).toContain('aria-valuemin="0" aria-valuemax="5" aria-valuenow="4" aria-label="Live: 4 of 5"');
    });

    test("an empty meter has no liquid, a full one fills the whole tube", () => {
      expect(meter(0, 3)).toContain('class="tube ');
      expect(liquid(meter(0, 3))).toBeUndefined();
      expect(liquid(meter(3, 3))).toBe("col-span-3");
      expect(liquid(meter(5, 3))).toBe("col-span-3");
      expect(liquid(meter(12, 12))).toBe("col-span-12");
    });

    test("above 12 Slots the tube has no Slot marks and the liquid fills to the nearest tenth", () => {
      const big = meter(7, 20);
      expect(big).toMatch(/<span class="tube [^"]*grid-cols-10[^"]*">/);
      expect(liquid(big)).toBe("col-span-4");
      expect(big).not.toContain('class="slots');
      expect(liquid(meter(20, 20))).toBe("col-span-10");
    });

    test("the tube is 18 px tall and holds a canvas for the moving liquid, decoration only, next to the CSS liquid", () => {
      const live = meter(4, 5);
      expect(live).toMatch(
        /<span class="tube [^"]*"><span class="liquid [^"]*"><\/span><canvas class="brew" aria-hidden="true"><\/canvas>/,
      );
      expect(meter(0, 5)).not.toContain("<canvas");
      const css = asset("dashboard.css");
      expect(css.match(/\.tube \{([^}]*)\}/)?.[1]).toContain("height: 18px");
      // While the shader draws, the CSS liquid gives way to it (the script marks the tube).
      expect(css).toMatch(/\.tube\.gl \.liquid \{[^}]*background: none/);
      expect(css).toMatch(/\.brew \{[^}]*position: absolute/);
    });

    test("the Slot marks keep their faint line and are a little whiter over the liquid", () => {
      const live = meter(4, 5);
      // Marks between used Slots lie over the liquid; the one at its front and those beyond it don't.
      expect(slotMarks(live)).toEqual(["", "wet", "wet", "wet", ""]);
      expect(slotMarks(meter(0, 3))).toEqual(["", "", ""]);
      expect(slotMarks(meter(3, 3))).toEqual(["", "wet", "wet"]);
      const css = asset("dashboard.css");
      // The built stylesheet writes white with alpha as `#ffffffAA`.
      const white = (rule: string) => Number.parseInt(rule.match(/#ffffff([0-9a-f]{2})\b/)?.[1] ?? "", 16) / 255;
      const dry = css.match(/\.slots > i \+ i \{([^}]*)\}/)?.[1] ?? "";
      expect(dry).toMatch(/border-left: 1px solid #ffffff/);
      expect(white(dry)).toBeCloseTo(0.12, 2);
      const wet = css.match(/\.slots > i\.wet \{([^}]*)\}/)?.[1] ?? "";
      expect(wet).toContain("border-left-color: #ffffff");
      expect(white(wet)).toBeGreaterThan(0.12);
      expect(white(wet)).toBeLessThanOrEqual(0.4);
      expect(wet).not.toMatch(/width|border-left:/);
    });

    test("without the shader the CSS liquid's light moves slowly (loops of 10 s or more), out of step across meters", () => {
      const css = asset("dashboard.css");
      const rules = [...css.matchAll(/\.liquid(?:::?[a-z-]+)? \{([^}]*)\}/g)].map((m) => m[1] ?? "");
      const animations = rules.flatMap((r) => [...r.matchAll(/animation: ([^;]+);/g)].map((m) => m[1] ?? ""));
      expect(animations.length).toBeGreaterThanOrEqual(2);
      for (const value of animations) {
        // An animation may come from a theme variable (`var(--animate-glide)`).
        const a = value.replace(
          /^var\((--[\w-]+)\)$/,
          (_, v: string) => css.match(new RegExp(`${v}: ([^;]+);`))?.[1] ?? value,
        );
        const seconds = Number(a.match(/([\d.]+)s\b/)?.[1]);
        expect(seconds).toBeGreaterThanOrEqual(10);
        // Light glides via transform only: no surface or width moves.
        const name = a.split(" ")[0];
        const frames = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\s*\\}`))?.[1] ?? "";
        expect(frames).toContain("transform");
        expect(frames).not.toMatch(/width|height|background-position/);
      }
      // Meters take their timing by position, so neighbours' highlights are never at the same spot.
      const timings = [...css.matchAll(/#capacity li:nth-child\(([^)]*)\) \.liquid::?(before|after) \{([^}]*)\}/g)];
      for (const pseudo of ["before", "after"]) {
        const own = timings.filter((m) => m[2] === pseudo).map((m) => m[3] ?? "");
        expect(own.length).toBeGreaterThanOrEqual(2);
        for (const r of own) {
          const d = Number(r.match(/animation-duration: ([\d.]+)s/)?.[1] ?? "NaN");
          expect(d).toBeGreaterThanOrEqual(10);
          expect(r).toMatch(/animation-delay: -[\d.]+s/);
        }
        expect(new Set(own).size).toBe(own.length);
      }
      expect(css).not.toContain(".gauge");
      expect(css).not.toContain("@keyframes flow");
    });

    test("the liquid is still for reduced motion: no CSS animation and no shader", () => {
      const reduced = asset("dashboard.css").slice(
        asset("dashboard.css").indexOf("@media (prefers-reduced-motion: reduce)"),
      );
      expect(reduced).toMatch(/:after \{[^}]*animation: none/);
      const js = asset("meters.js");
      expect(js).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    });

    test("one WebGL context draws every meter, about 30 frames a second, only while visible", () => {
      const js = asset("meters.js");
      expect(js.match(/getContext\("webgl"/g)?.length).toBe(1);
      expect(js).toContain('getContext("2d"');
      expect(js).toContain("visibilitychange");
      expect(js).toContain("IntersectionObserver");
      expect(js).toMatch(/now - last < 3\d/);
      // Each meter gets its own seed for phase, speed and pattern.
      expect(js).toMatch(/uniform float seed/);
      expect(overview()).toMatch(/<script src="\/assets\/meters\.js\?v=[0-9a-f]+" defer=""><\/script>/);
    });
    test("REQ-003-24 the liquid has no bubbles, and the Usage quota's tubes move too", () => {
      const js = asset("meters.js");
      expect(js).not.toMatch(/bubble/i);
      // No loop in the shader (the bubbles were its only one besides the noise octaves).
      const shader = js.slice(js.indexOf("void main(){\n"), js.indexOf("}`;"));
      expect(shader).not.toMatch(/for\s*\(/);
      expect(js).toContain("#usage-quota");
      expect(js).toMatch(/\.observe\(/);
      expect(js.match(/getContext\("webgl"/g)?.length).toBe(1);
    });
  });

  test("REQ-003-26 the pointer stirs a meter's liquid, a tap on a phone too, and it calms down", () => {
    const js = asset("meters.js");
    // REQ-003-26: stirring brings no bubbles.
    expect(js).not.toMatch(/bubble/i);
    expect(js).toContain('"pointermove"');
    expect(js).toContain('"pointerdown"');
    expect(js).toMatch(/uniform float stir/);
    // The stir decays over about 2 s.
    expect(js).toMatch(/STIR_CALM_SEC = [12](\.\d+)?/);
  });

  test("REQ-003-01 each session shows its model and its Remote Control name, with a copy button only for scripts", () => {
    const html = overview();
    // REQ-003-41: by name, the id on hover.
    expect(html).toContain('<span class="font-mono text-[11px]" title="claude-sonnet-5-5">Sonnet 5.5</span>');
    expect(html).toContain("#6 Add search · Implementer · app");
    expect(html).toMatch(/<button[^>]*data-copy="#6 Add search · Implementer · app"[^>]*hidden/);
  });

  test("REQ-003-16 Recent comes before Now in Activity: each Event with icon, tone, time and links", () => {
    const html = overview();
    const recent = html.slice(html.indexOf('id="recent"'), html.indexOf('id="now"'));
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
    const narrowed = lib.slice(lib.indexOf('id="recent"'), lib.indexOf('id="now"'));
    expect(narrowed).toContain("#2 failed: boom");
    expect(narrowed).not.toContain("Review of PR #70");
  });

  test("REQ-003-20 Activity: one header with the counts, Recent, Now and Next as one timeline, stacked Now, Next, Recent on a phone", () => {
    const html = overview();
    const activity = html.slice(html.indexOf('id="activity"'), html.indexOf('id="pipeline"'));
    // The fixture has one running session, no idle one, and one queued step that waits.
    expect(activity).toMatch(/<h2 [^>]*>Activity <span[^>]*>1 running · 0 idle · 1 queued<\/span><\/h2>/);
    const head = (id: string) =>
      activity.match(new RegExp(`<section id="${id}" class="([^"]*)"><h3 [^>]*>([\\s\\S]*?)</h3>`));
    // #146: each part has a single heading, no second label repeating it; Now's dot marks it current.
    const text = (h?: string) => h?.replace(/<[^>]*>/g, "").trim();
    expect(text(head("recent")?.[2])).toBe("Recent");
    expect(text(head("now")?.[2])).toBe("Now");
    expect(text(head("next")?.[2])).toBe("Next");
    expect(head("now")?.[2]).toMatch(/<span aria-hidden="true" class="[^"]*\bbg-acc\b[^"]*shadow-/);
    // Time order from lg on (the DOM order), Now, Next, Recent on a phone.
    expect(head("now")?.[1]).toMatch(/\border-1\b.*\blg:order-none\b/);
    expect(head("next")?.[1]).toMatch(/\border-2\b.*\blg:order-none\b/);
    expect(head("recent")?.[1]).toMatch(/\border-3\b.*\blg:order-none\b/);
    expect(activity).toMatch(/class="timeline grid [^"]*lg:grid-cols-\[/);
    // #74: no heading says an idle session is working.
    expect(html).not.toContain("Working now");
    // Next is a plain list in the row style of Recent, without the sideways pipe.
    const next = html.slice(html.indexOf('id="next"'), html.indexOf('id="pipeline"'));
    expect(next).not.toContain("overflow-x-auto");
    expect(next).not.toContain('class="step');
    const rowClass = (part: string) =>
      part.match(/<li class="(flex items-start gap-3 border-line border-t py-3 first:border-t-0) /)?.[1];
    expect(rowClass(next)).toBeDefined();
    expect(rowClass(next)).toBe(rowClass(html.slice(html.indexOf('id="recent"'), html.indexOf('id="now"'))));
  });

  /**
   * REQ-003-23: a part of Activity cut into what shows at first, what "Show N more" reveals, and the
   * two links, in page order. Each piece is empty if missing.
   */
  const capped = (part: string) => {
    const at = (m: string) => part.indexOf(`data-capped="${m}"`);
    const piece = (from: string, to?: string) =>
      at(from) < 0 ? "" : part.slice(at(from), to === undefined ? undefined : at(to));
    return {
      toggle: part.match(/<input [^>]*data-capped="toggle"[^>]*>/)?.[0] ?? "",
      shown: piece("first", "rest"),
      rest: piece("rest", "more"),
      more: piece("more", "less"),
      less: piece("less"),
      order: ["toggle", "first", "rest", "more", "less"].map(at),
    };
  };

  /** REQ-003-23: the expander is a checkbox and two labels, not a `<details>` disclosure. */
  const expectExpander = (part: string, n: number) => {
    const c = capped(part);
    expect(part).not.toMatch(/<details|<summary/);
    expect(c.toggle).toMatch(/^<input type="checkbox"/);
    const id = c.toggle.match(/ id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    // "Show N more" under the first five, "Show less" under the rest once they are open.
    expect(c.order.every((o, i) => o >= 0 && (i === 0 || o > (c.order[i - 1] ?? 0)))).toBe(true);
    expect(c.more).toMatch(new RegExp(`^data-capped="more"[^>]*for="${id}"[^>]*>Show ${n} more</label>`));
    expect(c.less).toMatch(new RegExp(`^data-capped="less"[^>]*for="${id}"[^>]*>Show less</label>`));
    // Which link shows is up to `.capped`; a display utility on a link would win over it (utilities layer).
    for (const label of [c.more, c.less])
      expect(label.match(/class="([^"]*)"/)?.[1]).not.toMatch(
        /(?:^|\s)(?:inline-block|block|inline|flex|inline-flex|grid|hidden)(?:\s|$)/,
      );
    return c;
  };

  test("REQ-003-23 the last item shown fades out until the rest is open, and the rest shows only when it is", () => {
    // Combinators without spaces, so the selectors read the same however the stylesheet is printed.
    const css = asset("dashboard.css").replace(/\s*([>~])\s*/g, "$1");
    const rule = (selector: RegExp) => css.match(new RegExp(`${selector.source}[^{]*\\{[^}]*\\}`))?.[0] ?? "";
    const q = '"?';
    // The rest and "Show less" are hidden until the toggle is checked; then "Show more" hides.
    expect(rule(new RegExp(`\\.capped>\\[data-capped=${q}rest${q}\\]`))).toMatch(/display:\s*none/);
    expect(rule(new RegExp(`:checked~\\[data-capped=${q}rest${q}\\]`))).toMatch(/display:\s*block/);
    expect(rule(new RegExp(`:checked~\\[data-capped=${q}more${q}\\]`))).toMatch(/display:\s*none/);
    // While closed, the last item shown fades out downwards.
    expect(rule(new RegExp(`:not\\(:checked\\)~\\[data-capped=${q}first${q}\\]>\\*>:last-child`))).toMatch(
      /mask-image:\s*linear-gradient\([^;]*(?:transparent|#0000)/,
    );
  });

  test('REQ-003-16 / REQ-003-23 Recent shows 5 of its 15 Events at every width and the other 10 behind "Show 10 more"', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      at: new Date(Date.parse("2026-11-15T10:20:00.000Z") - i * 60_000).toISOString(),
      repo: "octo/app",
      kind: "approved" as const,
      issues: [i + 1],
      pr: null,
      text: `Event ${i + 1} happened`,
    }));
    const html = renderDashboard(dashboardView({ ...snap, events }, config, NOW));
    const recent = html.slice(html.indexOf('id="recent"'), html.indexOf('id="now"'));
    const { shown, rest } = expectExpander(recent, 10);
    for (let n = 1; n <= 5; n++) expect(shown).toContain(`Event ${n} happened`);
    expect(shown).not.toContain("Event 6 happened");
    for (let n = 6; n <= 15; n++) expect(rest).toContain(`Event ${n} happened`);
    // Nothing forces it open on a wide screen.
    expect(recent).not.toMatch(/lg:details-content|lg:hidden|checked=""/);
    // With 5 or fewer Events there is nothing to expand.
    expect(overview()).not.toContain("data-capped");
  });

  test('REQ-003-23 Next shows its first 5 steps and the rest, blocked issues last, behind "Show N more"', () => {
    const queue = Array.from({ length: 8 }, (_, i) => ({
      work: {
        key: `octo/app#${i + 10} implement`,
        kind: "implement" as const,
        role: "implementer" as const,
        queuedAt: "t",
      },
      wait: { kind: "max-running" as const },
    }));
    const html = renderDashboard(dashboardView({ ...snap, queue }, config, NOW));
    const next = html.slice(html.indexOf('id="next"'), html.indexOf('id="pipeline"'));
    // 3 more steps plus the blocked issue, in the same order and row style.
    const { shown, rest } = expectExpander(next, 4);
    for (let n = 10; n <= 14; n++) expect(shown).toContain(`octo/app#${n} implement`);
    expect(shown).toMatch(/data-step="next"/);
    expect(shown).not.toContain("octo/app#15 implement");
    const marks = order(rest, ["octo/app#15", "octo/app#16", "octo/app#17", 'data-step="blocked"']);
    expect(marks.every((m) => m >= 0)).toBe(true);
    expect(marks).toEqual([...marks].sort((a, b) => a - b));
    expect(rest).not.toContain('data-step="next"');
    // The header counts stay the totals.
    expect(html).toContain("8 queued");
  });

  test('REQ-003-23 Now shows its first 5 sessions, running ones first, and the rest behind "Show N more"', () => {
    const base = snap.sessions[0];
    if (!base) throw new Error("fixture has a session");
    const sessions = Array.from({ length: 7 }, (_, i) => ({
      ...base,
      id: i + 1,
      issues: [i + 20],
      title: `Session ${i + 1} work`,
      state: (i < 4 ? "running" : "idle") as "running" | "idle",
    }));
    const html = renderDashboard(dashboardView({ ...snap, sessions }, config, NOW));
    const now = html.slice(html.indexOf('id="now"'), html.indexOf('id="next"'));
    const { shown, rest } = expectExpander(now, 2);
    for (let n = 1; n <= 5; n++) expect(shown).toContain(`Session ${n} work`);
    expect(shown).not.toContain("Session 6 work");
    for (const n of [6, 7]) expect(rest).toContain(`Session ${n} work`);
    // Same session style in the rest as above it.
    const listClass = (s: string) => s.match(/<ul class="([^"]*)"/)?.[1];
    expect(listClass(rest)).toBe(listClass(shown));
    // Each part has its own toggle.
    expect(capped(now).toggle).not.toBe("");
  });

  test("REQ-003-23 a part with exactly 5 items has no expander", () => {
    const queue = Array.from({ length: 4 }, (_, i) => ({
      work: {
        key: `octo/app#${i + 10} implement`,
        kind: "implement" as const,
        role: "implementer" as const,
        queuedAt: "t",
      },
    }));
    const events = Array.from({ length: 5 }, (_, i) => ({
      at: new Date(Date.parse("2026-11-15T10:20:00.000Z") - i * 60_000).toISOString(),
      repo: "octo/app",
      kind: "approved" as const,
      issues: [i + 1],
      pr: null,
      text: `Event ${i + 1} happened`,
    }));
    // 4 queued steps + 1 blocked issue = 5 in Next; 5 Events in Recent.
    const html = renderDashboard(dashboardView({ ...snap, queue, events }, config, NOW));
    expect(html).not.toMatch(/data-capped|<details/);
  });

  test("REQ-003-04 the first step is marked next, waiting steps say why, blocked issues are marked", () => {
    const html = overview();
    const upNext = html.slice(html.indexOf('id="next"'), html.indexOf('id="pipeline"'));
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

  test("REQ-003-02 hovering a card doesn't widen the Pipeline: each card clips its own sideways overflow (#121)", () => {
    const pipeline = overview().slice(overview().indexOf('id="pipeline"'));
    const cards = pipeline.match(/<li class="[^"]*"[^>]*data-tone=/g) ?? [];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card).toMatch(/[" ]overflow-x-clip[" ]/);
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
    expect(html).toContain("GitHub sign-in not set up");
    expect(html).toContain("maxWorktrees");
    expect(html).toMatch(/Reviewer[\s\S]*title="haiku">Haiku \(latest\)<[\s\S]*low/);
    expect(html).toContain("bun install");
    expect(html).toMatch(/Auto-merge<\/dt>\s*<dd[^>]*>(<code[^>]*>)?off/); // REQ-001-65
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

  test("REQ-003-31 with the GitHub sign-in set up, the header has a Sign out button posting to /auth/logout", () => {
    const signedIn = parseConfig({
      ...config,
      dashboard: { githubLogin: { clientId: "Ov23li", clientSecretPath: "/secret/github-client-secret" } },
    });
    for (const html of [
      renderDashboard(dashboardView(snap, signedIn, NOW)),
      renderConfig(dashboardView(snap, signedIn, NOW)),
    ]) {
      const form = /<form [^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
      expect(form).toContain('action="/auth/logout"');
      expect(form).toContain('method="post"');
      // REQ-003-39: the label is hidden on a phone, so the button keeps "Sign out" as its accessible name.
      expect(form).toMatch(/<button type="submit"[^>]*>[\s\S]*Sign out(<\/span>)?<\/button>/);
      expect(html).not.toContain("/secret");
    }
    expect(renderConfig(dashboardView(snap, signedIn, NOW))).toContain("GitHub sign-in, Owner only");
    expect(renderConfig(dashboardView(snap, signedIn, NOW))).toContain("Only the sign-in calls GitHub");
    for (const html of [overview(), configPage()]) expect(html).not.toContain("/auth/logout");
  });

  describe("REQ-003-39 fixed frosted header", () => {
    const signedIn = parseConfig({
      ...config,
      dashboard: { githubLogin: { clientId: "Ov23li", clientSecretPath: "/secret/github-client-secret" } },
    });
    const header = (html: string) => /<header [^>]*>[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";

    test("every page's header is the sticky frosted bar, its content in the page column", () => {
      for (const html of [overview(), configPage(), timingsPage()]) {
        const h = header(html);
        expect(h).toMatch(/^<header class="topbar"/);
        expect(h).toMatch(/^<header [^>]*>\s*<div class="wrap /);
      }
    });

    test("on a phone one row: the wordmark and Read-only are hidden, below 380 px the countdown keeps only its ring", () => {
      const h = header(overview());
      expect(h).toMatch(
        /<a [^>]*aria-label="Coordinator"[^>]*>[\s\S]*?<span class="max-sm:hidden">Coordinator<\/span>/,
      );
      expect(h).toMatch(/<span class="[^"]*max-sm:hidden[^"]*">[\s\S]*?Read-only<\/span>/);
      expect(h).toMatch(/<span class="[^"]*max-\[379px\]:hidden[^"]*" data-countdown="">/);
      expect(h).not.toContain("flex-wrap");
    });

    test("Sign out is an icon button on a phone and keeps its accessible name", () => {
      for (const html of [
        renderDashboard(dashboardView(snap, signedIn, NOW)),
        renderConfig(dashboardView(snap, signedIn, NOW)),
      ]) {
        const button = /<button type="submit"[^>]*>[\s\S]*?<\/button>/.exec(header(html))?.[0] ?? "";
        expect(button).toContain('aria-label="Sign out"');
        expect(button).toMatch(/<span class="max-sm:hidden">Sign out<\/span>/);
      }
    });

    test("the stylesheet pins the bar above the glass, frosts it, and offsets anchors below it", () => {
      const css = asset("dashboard.css");
      const bar = css.match(/\.topbar \{([^}]*)\}/)?.[1] ?? "";
      expect(bar).toContain("position: sticky");
      expect(bar).toContain("top: 0");
      expect(bar).toContain("z-index: 40");
      expect(bar).toMatch(/-webkit-backdrop-filter: blur\(/);
      expect(bar).toMatch(/\sbackdrop-filter: blur\(/);
      expect(bar).toContain("border-bottom: 1px solid");
      expect(bar).toContain("padding-top: env(safe-area-inset-top)");
      expect(css).toMatch(/\[id\] \{\s*scroll-margin-top: calc\(/);
    });
  });

  test("REQ-003-06 a countdown to the next refresh, and a meta refresh for browsers without JavaScript", () => {
    for (const html of [overview(), configPage()]) {
      expect(html).toContain('data-reload="45"');
      expect(html).toContain('<noscript><meta http-equiv="refresh" content="45"/></noscript>');
    }
  });

  test("REQ-003-06 no Last tick line: the last tick's time is in the countdown's tooltip", () => {
    for (const html of [overview(), configPage()]) {
      expect(html).not.toMatch(/Last tick[^<"]*ago/);
      expect(html).toMatch(/<span [^>]*data-reload="45" title="Last tick 2026-11-15 10:29 UTC · refreshes every 45 s"/);
      expect(html.match(/Last tick/g)).toHaveLength(1);
    }
  });

  test("REQ-003-28 a failed refresh turns the countdown red", () => {
    const css = asset("dashboard.css");
    expect(css).toMatch(/\[data-failed\] \{\s*color: var\(--color-bad\)/);
    expect(css).toMatch(/\[data-failed\] \.ring-fg \{\s*stroke: var\(--color-bad\)/);
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
    // Its glows sit on their own fixed layer below #bg, so they can move with the scroll (REQ-003-25).
    expect(rule("html")).toContain("linear-gradient");
    expect(rule("body::?before")).toContain("radial-gradient");
    expect(rule("body::?before")).toContain("z-index: -1");
    expect(rule("body")).not.toContain("background");
    expect(rule("#bg")).toContain("z-index: -1");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("animation: none");
    expect(reduced).toContain("transition: none");
    expect(reduced).not.toContain("#bg");
    const js = asset("dashboard.js");
    // Reduced motion only stops the background following the scroll (REQ-003-25); it never stops the drawing.
    expect(js.match(/prefers-reduced-motion/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(js).toContain("visibilitychange");
    expect(js).toContain('getContext("webgl"');
  });

  describe("REQ-003-27 comet scrollbar", () => {
    const css = () => asset("dashboard.css");
    /** The declarations of a rule; `::` also matches the single colon the minifier writes. */
    const rule = (selector: string) =>
      css().match(
        new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.[\]()]/g, "\\$&").replaceAll("::", "::?")} \\{([^}]*)\\}`),
      )?.[1] ?? "";
    const reduced = () => css().slice(css().indexOf("@media (prefers-reduced-motion: reduce)"));

    test("the browser's scrollbar is hidden only once the script has marked the page, so without it the page keeps its own", () => {
      expect(rule("html.has-comet")).toContain("scrollbar-width: none");
      expect(rule("html.has-comet::-webkit-scrollbar")).toContain("display: none");
      expect(css()).not.toMatch(/(?:^|[\s,}])(html|body|:root) \{[^}]*scrollbar-width: none/);
      for (const html of [overview(), configPage()]) expect(html).not.toContain("has-comet");
      const js = asset("dashboard.js");
      expect(js).toContain('classList.add("has-comet")');
    });

    test("the comet catches pointers only on itself, can be dragged, and leaves scrolling to the browser", () => {
      expect(rule(".comet")).toContain("position: fixed");
      expect(rule(".comet")).toContain("pointer-events: none");
      expect(rule(".comet-thumb")).toContain("pointer-events: auto");
      expect(rule(".comet-thumb")).toContain("touch-action: none");
      const js = asset("dashboard.js");
      expect(js).toContain("setPointerCapture");
      expect(js).toMatch(/addEventListener\(\s*"scroll",[\s\S]*?\{ passive: true \}/);
      // The comet never takes over the wheel, keys or touch scrolling.
      expect(js).not.toMatch(/addEventListener\(\s*"(wheel|keydown|touchmove|mousewheel)"/);
      expect(js).not.toContain("preventDefault");
    });

    test("a plasma-drop head, a tail while scrolling, slim and dim at rest, hidden with nothing to scroll", () => {
      expect(rule(".comet-head")).toContain("var(--stretch");
      expect(rule(".comet-tail")).toContain("var(--tail");
      expect(css()).toMatch(/\.comet\.on \.comet-thumb::?before \{[^}]*animation/);
      expect(rule(".comet-thumb::before")).toContain("opacity");
      const js = asset("dashboard.js");
      expect(js).toContain("scrollHeight");
      expect(js).toMatch(/\.hidden = /);
    });

    test("a comet shown after a page grows measures its track once visible (review of #122)", () => {
      // A hidden comet measures 0 high; measured before it is shown, the thumb sat above the track.
      const js = asset("dashboard.js");
      const layout = js.slice(js.indexOf("const layout = () =>"), js.indexOf("const draw = () =>"));
      expect(layout).toContain("comet.hidden = ");
      expect(layout).toContain("comet.clientHeight");
      expect(layout.indexOf("comet.hidden = ")).toBeLessThan(layout.indexOf("comet.clientHeight"));
    });

    test("scrolling up, the drop turns round but stays on the bar's end", () => {
      // Turning the whole head about its top edge would lift it off the bar; only the drop inside turns.
      const up = rule('.comet[data-dir="up"] .comet-head');
      expect(up).toContain("transform-origin: 50% 0");
      expect(up).not.toContain("rotate");
      expect(rule('.comet[data-dir="up"] .comet-head::before')).toContain("rotate(225deg)");
    });

    test("a flip of the direction glides the head along the bar and turns the drop on the way (#126)", () => {
      // Switching top/bottom can't be animated: the head sits at the top end and is moved by `translate`.
      const head = rule(".comet-head");
      expect(head).toContain("top: -5px");
      expect(head).not.toMatch(/(^|[\s;])bottom:/);
      expect(head).toMatch(/transition:[^;]*translate 0?\.3s/);
      const up = rule('.comet[data-dir="up"] .comet-head');
      expect(up).not.toMatch(/(^|[\s;])(top|bottom):/);
      expect(up).toMatch(/translate: 0(;|\s*$)/);
      // "Down" is the base state (review of #136): before the first scroll there is no data-dir, and the head
      // waits at the bottom end, so the first scroll down doesn't glide it there from the top. That end is the
      // thumb's height (set by the script) less the drop.
      expect(head).toContain("translate: 0 calc(var(--thumb-h");
      expect(asset("dashboard.js")).toMatch(/setProperty\("--thumb-h"/);
      expect(rule(".comet-head::before")).toMatch(/transition:[^;]*transform 0?\.3s/);
    });

    test("at rest the head fades out completely and only scrolling or dragging brings it back (#126)", () => {
      expect(rule(".comet-head")).toContain("opacity: 0;");
      expect(rule(".comet-head")).toMatch(/transition:[^;]*opacity/);
      expect(css()).toMatch(/\.comet\.on \.comet-head,\s*\.comet\.drag \.comet-head \{[^}]*opacity: 1/);
      // Hovering only lights the bar, never the head.
      expect(css()).not.toMatch(/:hover[^{]*\.comet-head/);
    });

    test("with reduced motion the comet is a plain bar: no flow, no tail, no head, no glide", () => {
      expect(reduced()).toMatch(/\.comet-tail,\s*\.comet-head \{[^}]*display: none/);
      expect(reduced()).toContain("animation: none");
    });
  });

  describe("REQ-003-25 background parallax", () => {
    const js = () => asset("dashboard.js");

    test("the metal and the light follow the scroll at about 30 % and 15 %, and the pointer's dent stays put", () => {
      expect(js()).toContain("uniform float scroll;");
      expect(js()).toMatch(/const METAL = 0\.3\b/);
      expect(js()).toMatch(/const GLOW = 0\.15\b/);
      // The dent is measured from the unshifted point on the screen, the folds from the shifted one.
      expect(js()).toMatch(/vec2 d=p-m;/);
      expect(js()).toMatch(/vec2 w=p-vec2\(0\.,scroll\);/);
    });

    test("scrolling stirs the metal like the pointer: its speed feeds the dent's energy", () => {
      expect(js()).toMatch(/energy = Math\.min\(1, energy \+ [^;]*scroll/i);
    });

    test("without WebGL the glows move too, on their own layer; with reduced motion nothing follows the scroll", () => {
      const css = asset("dashboard.css");
      expect(css).toMatch(/body::?before \{[^}]*transform: translate3d\(0, var\(--glow-y/);
      expect(js()).toContain("--glow-y");
      // The glows are set before the WebGL check, so they move without it.
      expect(js().indexOf("--glow-y")).toBeLessThan(js().indexOf('getContext("webgl"'));
      expect(js()).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    });
  });

  test("REQ-003-17 the dropdown of a select is dark with readable text, not the browser's white popup (#145)", () => {
    const css = asset("dashboard.css");
    const rule = css.match(/(?:^|[}\s])select,\s*option\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/background-color:\s*var\(--color-ink-2\)/);
    expect(rule).toMatch(/(?:^|[;\s])color:\s*var\(--color-fg\)/);
    expect(rule).toMatch(/color-scheme:\s*dark/);
    expect(css).toMatch(/option:checked[^{]*\{[^}]*background-color:\s*var\(--color-acc-lo\)/);
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
