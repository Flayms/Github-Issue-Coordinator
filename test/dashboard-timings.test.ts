import { describe, expect, test } from "bun:test";
import { labelLines, type TimingsView, timingsView } from "../src/dashboard/timings.ts";
import { renderTimings } from "../src/dashboard/timings-html.tsx";
import { dashboardView } from "../src/dashboard/view.ts";
import type { Timing } from "../src/store.ts";
import {
  MOCK_CONFIG,
  MOCK_NOW,
  MOCK_SNAPSHOT,
  MOCK_TIMED_ISSUES,
  MOCK_TIMING_SOURCE,
  MOCK_TIMINGS,
} from "./fixtures/dashboard-mock.ts";

const view = (o: { pick?: string | null; includeOwner?: boolean; source?: typeof MOCK_TIMING_SOURCE } = {}) =>
  timingsView({
    source: o.source ?? MOCK_TIMING_SOURCE,
    pick: o.pick ?? null,
    includeOwner: o.includeOwner ?? false,
    now: MOCK_NOW,
  });
const segments = (v: TimingsView) =>
  v.rows.map((r) => [r.phase, r.steps.map((s) => `${s.label} ${s.duration} ${s.kind}`)]);
/** Each step as [start, length] in % of the issue's axis. */
const placed = (v: TimingsView) => v.rows.map((r) => r.steps.map((s) => [s.at, s.width]));

describe("dashboard timings", () => {
  test("REQ-003-34 each phase is a row of labelled segments in time order; the Owner's time is left out by default", () => {
    const v = view();
    expect(v.picked).toMatchObject({
      repo: "acme/payments-api",
      issue: 41,
      title: "Retry webhooks with exponential backoff",
      url: "https://github.com/acme/payments-api/issues/41",
    });
    expect(v.includeOwner).toBe(false);
    expect(segments(v)).toEqual([
      ["Planning", ["Waited for the Planner 14 min queued", "Planner 9 min agent", "Revise 1 6 min agent"]],
      ["Building", ["Waited for an Implementer 22 min queued", "Implementer 48 min agent"]],
      [
        "Review",
        [
          "Checks 7 min checks",
          "Reviewer 12 min agent",
          "Feedback round 1 17 min agent",
          "Checks 6 min checks",
          "Reviewer 8 min agent",
        ],
      ],
    ]);
    expect(v.totals).toEqual({
      total: "2 h 29 min",
      totalLabel: "without your time",
      agents: "1 h 40 min",
      agentsPercent: 67,
      queued: "36 min",
      queuedPercent: 24,
      rounds: 2,
    });
  });

  test("REQ-003-34 every step starts on one shared time axis where it really started; the Owner's time is cut out of it", () => {
    const v = view();
    // 149 min: the Owner's 95 + 40 min in Planning are cut, so Revise 1 follows the Planner and Building follows Revise 1.
    expect(v.axis).toBe("2 h 29 min");
    expect(placed(v)).toEqual([
      [
        [0, 9.4],
        [9.4, 6.04],
        [15.44, 4.03],
      ],
      [
        [19.46, 14.77],
        [34.23, 32.21],
      ],
      [
        [66.44, 4.7],
        [71.14, 8.05],
        [79.19, 11.41],
        [90.6, 4.03],
        [94.63, 5.37],
      ],
    ]);
    expect(v.rows.map((r) => r.duration)).toEqual(["29 min", "1 h 10 min", "50 min"]);
    expect(v.marks).toEqual([
      { label: "0", at: 0 },
      { label: "30 min", at: 20.13 },
      { label: "1 h", at: 40.27 },
      { label: "1 h 30 min", at: 60.4 },
      { label: "2 h", at: 80.54 },
    ]);
  });

  test('REQ-003-34 with "Include your time" the Owner\'s time takes its place on the axis and the steps after it move', () => {
    const v = view({ includeOwner: true });
    expect(v.axis).toBe("4 h 44 min");
    // Your reply (95 min) sits between the Planner and Revise 1, your approval (40 min) before Building.
    expect(placed(v)[0]).toEqual([
      [0, 4.93],
      [4.93, 3.17],
      [8.1, 33.45],
      [41.55, 2.11],
      [43.66, 14.08],
    ]);
    expect(placed(v)[1]?.[0]).toEqual([57.75, 7.75]);
    expect(v.marks.map((m) => m.label)).toEqual(["0", "1 h", "2 h", "3 h", "4 h"]);
    expect(v.totals).toMatchObject({ agentsPercent: 35, queuedPercent: 13 });
  });

  test("REQ-003-34 on a phone each phase is on its own scale", () => {
    const v = view();
    expect(v.rows.map((r) => r.steps.map((s) => [s.phaseAt, s.phaseWidth]))).toEqual([
      [
        [0, 48.28],
        [48.28, 31.03],
        [79.31, 20.69],
      ],
      [
        [0, 31.43],
        [31.43, 68.57],
      ],
      [
        [0, 14],
        [14, 24],
        [38, 34],
        [72, 12],
        [84, 16],
      ],
    ]);
  });

  test('REQ-003-34 with "Include your time" the Owner\'s reply and approval are segments too, and the total is end to end', () => {
    const v = view({ includeOwner: true });
    expect(v.rows[0]?.steps.map((s) => `${s.label} ${s.duration}`)).toEqual([
      "Waited for the Planner 14 min",
      "Planner 9 min",
      "Your reply 1 h 35 min",
      "Revise 1 6 min",
      "Your approval 40 min",
    ]);
    expect(v.totals).toMatchObject({ total: "4 h 44 min", totalLabel: "end to end", agents: "1 h 40 min" });
  });

  test("REQ-003-34 one step's running intervals are one segment; a running agent grows until now; under a second is left out", () => {
    const t = (o: Partial<Timing> & Pick<Timing, "kind" | "start" | "end">): Timing => ({
      repo: "octo/app",
      issue: 5,
      title: "T",
      phase: "review",
      role: "implementer",
      round: 1,
      sessionId: 1,
      ...o,
    });
    const at = (min: number) => new Date(MOCK_NOW.getTime() - min * 60_000).toISOString();
    const timings = [
      t({ kind: "queued", start: at(60), end: at(60) }),
      t({ kind: "agent", start: at(60), end: at(40) }),
      t({ kind: "agent", start: at(30), end: null }), // resumed after a restart, still running
      t({ kind: "owner", role: null, start: at(40), end: at(30) }), // the Owner's comment on the PR
      t({ kind: "queued", round: 2, start: at(30), end: at(30) }),
    ];
    const source = {
      timedIssues: () => [{ repo: "octo/app", issue: 5, title: "T", lastAt: at(0) }],
      timings: () => timings,
    };
    const v = view({ source, includeOwner: true });
    expect(v.rows.map((r) => r.steps.map((s) => [s.label, s.duration, s.running]))).toEqual([
      [
        ["Feedback round 1", "50 min", true],
        ["Your reply", "10 min", false],
      ],
    ]);
    // Without the Owner's time the reply is cut out of the axis: the running step fills it up to now.
    const cut = view({ source });
    expect(cut.axis).toBe("50 min");
    expect(placed(cut)).toEqual([[[0, 100]]]);
  });

  test("REQ-003-34 checks running alongside the Review count once in the totals", () => {
    const at = (min: number) => new Date(MOCK_NOW.getTime() - min * 60_000).toISOString();
    const t = (o: Pick<Timing, "kind" | "role" | "start" | "end">): Timing => ({
      repo: "octo/app",
      issue: 5,
      title: "T",
      phase: "review",
      round: 1,
      sessionId: null,
      ...o,
    });
    const timings = [
      t({ kind: "queued", role: "reviewer", start: at(60), end: at(58) }),
      t({ kind: "agent", role: "reviewer", start: at(58), end: at(40) }),
      t({ kind: "checks", role: null, start: at(58), end: at(50) }),
    ];
    const source = {
      timedIssues: () => [{ repo: "octo/app", issue: 5, title: "T", lastAt: at(40) }],
      timings: () => timings,
    };
    const v = view({ source });
    expect(v.rows[0]?.steps.map((s) => `${s.label} ${s.duration}`)).toEqual([
      "Waited for the Reviewer 2 min",
      "Reviewer 18 min",
      "Checks 8 min",
    ]);
    expect(v.totals).toMatchObject({ total: "20 min", agents: "18 min", agentsPercent: 90, queuedPercent: 10 });
    // The checks overlap the Reviewer, so they go on a second track of the row, at their real start.
    expect(v.rows[0]?.lanes).toBe(2);
    expect(v.rows[0]?.steps.map((s) => [s.lane, s.at, s.width])).toEqual([
      [0, 0, 10],
      [0, 10, 90],
      [1, 10, 40],
    ]);
  });

  test("REQ-003-34 a label stands under its step's start and drops a line when it would run into the one before", () => {
    const v = view();
    const names = (row: number, px: number) =>
      labelLines(v.rows[row]?.steps ?? [], px).map((line) =>
        line.map((l) => `${v.rows[row]?.steps[l.step]?.label}${l.align === "end" ? " (end)" : ""}`),
      );
    expect(names(0, 1000)).toEqual([["Waited for the Planner", "Revise 1"], ["Planner"]]);
    // Narrower, Revise 1 runs into both labels before it.
    expect(names(0, 560)).toEqual([["Waited for the Planner"], ["Planner"], ["Revise 1"]]);
    // A label that would run past the end of the axis ends where its step ends.
    expect(names(2, 1000)).toEqual([["Checks", "Reviewer", "Feedback round 1", "Checks"], ["Reviewer (end)"]]);
    for (const px of [560, 1000])
      for (const row of [0, 1, 2])
        for (const line of labelLines(v.rows[row]?.steps ?? [], px)) {
          for (const l of line) expect(l.to).toBeLessThanOrEqual(100);
          for (const [a, b] of line.slice(1).map((l, i) => [line[i], l] as const))
            expect(b.from).toBeGreaterThanOrEqual(a?.to ?? 0);
        }
  });

  test("REQ-003-34 the picker lists the issues with Timings, newest first; an issue or a store with nothing recorded says so", () => {
    expect(view().issues).toEqual([
      {
        value: "acme/payments-api#41",
        label: "acme/payments-api#41 Retry webhooks with exponential backoff",
        selected: true,
      },
      {
        value: "acme/storefront#221",
        label: "acme/storefront#221 Add a dark mode toggle to the header",
        selected: false,
      },
      {
        value: "acme/storefront#229",
        label: "acme/storefront#229 Search suggestions are slow on mobile",
        selected: false,
      },
    ]);
    expect(MOCK_TIMED_ISSUES[0]?.issue).toBe(41);

    const other = view({ pick: "acme/storefront#221" });
    expect(other.issues.find((i) => i.selected)?.value).toBe("acme/storefront#221");
    expect(other).toMatchObject({
      rows: [],
      marks: [],
      totals: null,
      empty: "Nothing recorded for acme/storefront#221 yet.",
    });
    expect(view({ pick: "acme/storefront#999" }).empty).toBe("Nothing recorded for acme/storefront#999 yet.");
    expect(view({ pick: "no issue" }).picked?.issue).toBe(41); // not an issue: the newest

    const none = view({ source: { timedIssues: () => [], timings: () => [] } });
    expect(none).toMatchObject({ issues: [], picked: null, rows: [], totals: null });
    expect(none.empty).toContain("No Timings recorded yet");
  });

  describe("page", () => {
    const page = (o: Parameters<typeof view>[0] = {}) =>
      renderTimings(dashboardView(MOCK_SNAPSHOT, MOCK_CONFIG, MOCK_NOW), view(o));

    test("REQ-003-34 a tab next to Overview and Config, and a picker that works without JavaScript", () => {
      const html = page();
      expect(html).toContain('<a href="/timings" aria-current="page"');
      expect(html.indexOf('href="/config"')).toBeLessThan(html.indexOf('href="/timings"'));
      expect(html).toContain("<title>Timings · Coordinator</title>");
      const form = /<form[^>]*action="\/timings"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
      expect(form).toMatch(/^<form[^>]*method="get"/);
      expect(form).toMatch(/<select[^>]*name="issue"/);
      expect(form).toContain('<option value="acme/payments-api#41" selected="">');
      expect(form).toMatch(/<input type="checkbox"[^>]*name="owner" value="1"/);
      expect(form).not.toContain('checked=""');
      expect(form).toMatch(/<button type="submit"[^>]*>Show<\/button>/);
      expect(page({ includeOwner: true })).toMatch(
        /<input type="checkbox"[^>]*checked=""[^>]*name="owner"|name="owner"[^>]*checked=""/,
      );
    });

    test("REQ-003-34 / REQ-003-09 KPI tiles, rows on one time axis sized by attributes, labels and marks; no inline style", () => {
      const html = page();
      for (const text of ["Planning", "Building", "Review", "Waited for the Planner", "Feedback round 1", "Revise 1"])
        expect(html).toContain(`>${text}<`);
      expect(html).toContain(">2 h 29 min<");
      expect(html).toContain("total, without your time");
      expect(html).toContain(">1 h 40 min<");
      expect(html).toContain("agents working · 67 %");
      expect(html).toContain(">36 min<");
      expect(html).toContain("waiting in the queue · 24 %");
      expect(html).toContain("Revise / Feedback rounds");
      // The time marks over the rows.
      for (const mark of ["0", "30 min", "1 h", "1 h 30 min", "2 h"]) expect(html).toContain(`>${mark}<`);
      // Building's wait starts at 19.46 % and lasts 14.77 %: a spacer cell, then the capsule's cell.
      expect(html).toMatch(/<td width="19\.46%"><\/td><td width="14\.77%"[^>]*><span class="tube /);
      expect(html).toContain("Each phase on its own scale");
      expect(html).not.toContain("Your reply");
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).toContain('href="https://github.com/acme/payments-api/issues/41"');
      expect(page({ includeOwner: true })).toContain(">Your approval<");
      expect(page({ includeOwner: true })).toContain("total, end to end");
    });

    test("REQ-003-45 each step is a glass capsule: liquid for an agent, checks and the Owner, empty glass for a wait", () => {
      const html = page({ includeOwner: true });
      const chart = html.slice(html.indexOf('id="timeline"'));
      const tubes = [...chart.matchAll(/<span class="tube ([^"]*)"( data-tint="(\w+)")?>(.*?)<\/span><\/td>/g)].map(
        (m) => ({
          tint: m[3] ?? "",
          liquid: (m[4] ?? "").includes('<span class="liquid'),
          brew: (m[4] ?? "").includes('<canvas class="brew"'),
        }),
      );
      // 12 steps, drawn on the shared axis and again on the phone's own scales.
      expect(tubes).toHaveLength(24);
      const first = tubes.slice(0, 5);
      expect(first).toEqual([
        { tint: "", liquid: false, brew: false }, // Waited for the Planner: empty glass
        { tint: "", liquid: true, brew: true }, // Planner: indigo
        { tint: "owner", liquid: true, brew: true }, // Your reply: amber
        { tint: "", liquid: true, brew: true },
        { tint: "owner", liquid: true, brew: true },
      ]);
      expect(tubes.filter((t) => t.tint === "checks")).toHaveLength(4);
      // The moving liquid is picked up on this page too.
      expect(html).toContain('id="timeline"');
    });

    test("REQ-003-34 with nothing recorded the page says so", () => {
      const html = page({ source: { timedIssues: () => [], timings: () => [] } });
      expect(html).toContain("No Timings recorded yet");
      expect(html).not.toContain("<select");
    });
  });

  test("REQ-003-34 the mock issue ends where its last interval ends", () => {
    expect(MOCK_TIMINGS.at(-1)?.end).toBe(MOCK_TIMED_ISSUES[0]?.lastAt);
  });
});
