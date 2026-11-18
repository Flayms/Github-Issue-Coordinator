import { describe, expect, test } from "bun:test";
import { type TimingsView, timingsView } from "../src/dashboard/timings.ts";
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
  v.rows.map((r) => [r.phase, r.segments.map((s) => `${s.label} ${s.duration} ${s.kind}`)]);
const shares = (v: TimingsView) => v.rows.map((r) => r.segments.map((s) => s.share));

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
    expect(v.totals).toEqual({ total: "2 h 29 min", totalLabel: "without your time", agents: "1 h 40 min", rounds: 2 });
    // One scale for all rows: the longest row (Building, 70 min) is the full width.
    expect(shares(v)).toEqual([
      [20, 12.86, 8.57],
      [31.43, 68.57],
      [10, 17.14, 24.29, 8.57, 11.43],
    ]);
  });

  test('REQ-003-34 with "Include your time" the Owner\'s reply and approval are segments too, and the total is end to end', () => {
    const v = view({ includeOwner: true });
    expect(v.rows[0]?.segments.map((s) => `${s.label} ${s.duration}`)).toEqual([
      "Waited for the Planner 14 min",
      "Planner 9 min",
      "Your reply 1 h 35 min",
      "Revise 1 6 min",
      "Your approval 40 min",
    ]);
    expect(v.totals).toMatchObject({ total: "4 h 44 min", totalLabel: "end to end", agents: "1 h 40 min" });
    expect(shares(v)[0]).toEqual([8.54, 5.49, 57.93, 3.66, 24.39]); // Planning (164 min) is now the longest
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
    expect(v.rows.map((r) => r.segments.map((s) => [s.label, s.duration, s.running]))).toEqual([
      [
        ["Feedback round 1", "50 min", true],
        ["Your reply", "10 min", false],
      ],
    ]);
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
    expect(v.rows[0]?.segments.map((s) => `${s.label} ${s.duration}`)).toEqual([
      "Waited for the Reviewer 2 min",
      "Reviewer 18 min",
      "Checks 8 min",
    ]);
    expect(v.totals).toMatchObject({ total: "20 min", agents: "18 min" });
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
    expect(other).toMatchObject({ rows: [], totals: null, empty: "Nothing recorded for acme/storefront#221 yet." });
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

    test("REQ-003-34 / REQ-003-09 rows with proportional segments sized by attributes, labels and totals; no inline style", () => {
      const html = page();
      for (const text of ["Planning", "Building", "Review", "Waited for the Planner", "Feedback round 1", "Revise 1"])
        expect(html).toContain(`>${text}<`);
      expect(html).toContain(">2 h 29 min<");
      expect(html).toContain("without your time");
      expect(html).toContain(">1 h 40 min<");
      expect(html).toContain("Revise / Feedback rounds");
      expect(html).toContain('width="68.57%"');
      expect(html).not.toContain("Your reply");
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).toContain('href="https://github.com/acme/payments-api/issues/41"');
      expect(page({ includeOwner: true })).toContain(">Your approval<");
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
