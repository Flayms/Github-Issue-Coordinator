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
  test("REQ-003-11 / REQ-003-12 / REQ-003-20 / REQ-003-02 the Overview shows its sections in order", () => {
    const html = overview();
    const at = order(html, [
      "PR ready to merge",
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
    const capacity = html.slice(html.indexOf('id="capacity"'), html.indexOf('id="activity"'));
    expect(capacity).toContain("Worktrees");
    expect(capacity).toMatch(/1<span[^>]*>\s*\/\s*3<\/span>/);
    expect(capacity).toContain('aria-label="Worktrees: 1 of 3"');
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
  });

  test("REQ-003-26 the pointer stirs a meter's liquid, a tap on a phone too, and it calms down", () => {
    const js = asset("meters.js");
    expect(js).toContain('"pointermove"');
    expect(js).toContain('"pointerdown"');
    expect(js).toMatch(/uniform float stir/);
    // The stir decays over about 2 s.
    expect(js).toMatch(/STIR_CALM_SEC = [12](\.\d+)?/);
  });

  test("REQ-003-01 each session shows its model and its Remote Control name, with a copy button only for scripts", () => {
    const html = overview();
    expect(html).toContain("claude-sonnet-5-5");
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
    expect(head("recent")?.[2]).toContain("Recent");
    expect(head("recent")?.[2]).toContain("done");
    expect(head("now")?.[2]).toContain("Now");
    expect(head("now")?.[2]).toContain("now");
    expect(head("next")?.[2]).toContain("Next");
    expect(head("next")?.[2]).toContain("next");
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
      expect(up).toContain("top: -5px");
      expect(up).toContain("transform-origin: 50% 0");
      expect(up).not.toContain("rotate");
      expect(rule('.comet[data-dir="up"] .comet-head::before')).toContain("rotate(225deg)");
    });

    test("with reduced motion the comet is a plain bar: no flow, no tail, no stretch", () => {
      expect(reduced()).toMatch(/\.comet-tail \{[^}]*display: none/);
      expect(reduced()).toMatch(/\.comet-head \{[^}]*--stretch: 1/);
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
