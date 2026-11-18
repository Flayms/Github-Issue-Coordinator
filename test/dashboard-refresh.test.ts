/**
 * The dashboard script's in-place refresh (REQ-003-28), run in happy-dom against pages rendered from
 * made-up snapshots. The poll interval is 1 s, so each refresh comes about a second after the last.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { parseConfig } from "../src/config.ts";
import type { TickSnapshot } from "../src/coordinator.ts";
import { asset } from "../src/dashboard/assets.ts";
import { renderDashboard } from "../src/dashboard/html.tsx";
import { timingsView } from "../src/dashboard/timings.ts";
import { renderTimings } from "../src/dashboard/timings-html.tsx";
import { dashboardView } from "../src/dashboard/view.ts";
import { MOCK_NOW, MOCK_TIMING_SOURCE } from "./fixtures/dashboard-mock.ts";

const config = parseConfig({
  owner: { login: "octo", id: 42 },
  pollIntervalSec: 1,
  limits: { maxWorktrees: 3 },
  roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app" }, { name: "octo/lib" }],
});
const NOW = new Date("2026-11-15T10:30:00Z");
const URL_ = "http://127.0.0.1:8080/?repo=octo%2Fapp";

/** A snapshot whose Recent holds `n` Events (more than 5, so it has a "Show N more" expander) and `worktrees` used. */
const snap = (label: string, n = 8, worktrees = 1): TickSnapshot => ({
  finishedAt: "2026-11-15T10:29:00.000Z",
  pausedUntil: null,
  repos: [
    { repo: "octo/app", error: null, issues: [], pulls: [], worktrees },
    { repo: "octo/lib", error: null, issues: [], pulls: [], worktrees: 0 },
  ],
  sessions: [],
  queue: [],
  events: Array.from({ length: n }, (_, i) => ({
    at: `2026-11-15T10:${String(20 - i).padStart(2, "0")}:00.000Z`,
    repo: "octo/app",
    kind: "failed" as const,
    issues: [i + 1],
    pr: null,
    text: `${label} event ${i + 1}`,
  })),
});
const page = (s: TickSnapshot) => renderDashboard(dashboardView(s, config, NOW, { repo: "octo/app" }));

let win: Window | undefined;
afterEach(async () => {
  await win?.happyDOM.close();
  win = undefined;
});

interface Server {
  /** What the next requests answer, in order; the last one repeats. */
  answers: (() => Promise<Response>)[];
  requests: string[];
}

/** Opens `html` in a fresh window with the dashboard script running and `fetch` answered by `server`. */
function open(html: string, server: Server) {
  win = new Window({ url: URL_, width: 1280, height: 900 });
  const w = win;
  const reloads: number[] = [];
  Object.defineProperty(w.location, "reload", { value: () => reloads.push(Date.now()), configurable: true });
  Object.defineProperty(w, "fetch", {
    configurable: true,
    value: (input: string) => {
      server.requests.push(String(input));
      const next = server.answers.length > 1 ? server.answers.shift() : server.answers[0];
      return next ? next() : Promise.reject(new TypeError("no answer"));
    },
  });
  w.document.write(html);
  const script = new TextDecoder().decode(asset("dashboard.js")?.body);
  (w as unknown as { eval: (code: string) => unknown }).eval(script);
  return { w, doc: w.document, reloads };
}

const ok = (html: string) => () =>
  Promise.resolve(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
const status = (code: number) => () => Promise.resolve(new Response("nope", { status: code }));
const down = () => Promise.reject(new TypeError("Failed to fetch"));

/** Waits until `cond` holds, up to `ms`. */
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("dashboard refresh", () => {
  test("REQ-003-28 refreshes in place: its own URL, only what changed, the background and open expanders stay", async () => {
    const server: Server = { answers: [ok(page(snap("new")))], requests: [] };
    const { doc, reloads } = open(page(snap("old")), server);
    const bg = doc.getElementById("bg");
    const header = doc.querySelector("header");
    const toggle = doc.querySelector('input[data-capped="toggle"]') as unknown as { checked: boolean } | null;
    const tube = doc.querySelector(".tube");
    expect(toggle).not.toBeNull();
    if (toggle) toggle.checked = true;
    tube?.classList.add("gl");
    const comet = doc.querySelector(".comet");
    expect(doc.body.textContent).toContain("old event 1");

    await until(() => (doc.body.textContent ?? "").includes("new event 1"));

    expect(server.requests).toEqual([URL_]);
    expect(reloads).toEqual([]);
    expect(doc.body.textContent).not.toContain("old event");
    // The same nodes, so the background keeps running and the meters keep their animation.
    expect(doc.getElementById("bg")).toBe(bg);
    expect(doc.querySelector("header")).toBe(header);
    expect(doc.querySelector(".tube")).toBe(tube);
    expect(tube?.classList.contains("gl")).toBe(true);
    expect(doc.querySelector(".comet")).toBe(comet);
    // The opened "Show N more" stays open.
    expect(doc.querySelector('input[data-capped="toggle"]') as unknown).toBe(toggle);
    expect(toggle?.checked).toBe(true);
    expect(doc.querySelectorAll("#bg")).toHaveLength(1);
  });

  test("REQ-003-28 the meters' canvases are kept as they are, and the meters are told to measure again", async () => {
    const server: Server = { answers: [ok(page(snap("old", 8, 2)))], requests: [] };
    const { w, doc } = open(page(snap("old", 8, 1)), server);
    const brew = doc.querySelector("canvas.brew");
    brew?.setAttribute("width", "321");
    let refreshed = 0;
    w.document.addEventListener("dashboard:refreshed", () => refreshed++);
    const liquid = doc.querySelector(".liquid")?.className;

    await until(() => refreshed > 0);

    expect(doc.querySelector("canvas.brew")).toBe(brew);
    expect(brew?.getAttribute("width")).toBe("321");
    expect(doc.querySelector(".liquid")?.className).not.toBe(liquid);
  });

  test("REQ-003-28 a failed refresh keeps the content, the countdown says so, and the next interval tries again", async () => {
    const server: Server = { answers: [down, ok(page(snap("new")))], requests: [] };
    const { doc, reloads } = open(page(snap("old")), server);
    const tick = doc.querySelector("[data-reload]");

    await until(() => tick?.hasAttribute("data-failed") === true);
    expect(doc.body.textContent).toContain("old event 1");
    expect(doc.querySelector("[data-countdown]")?.textContent).toContain("failed");
    expect(tick?.getAttribute("title")).toContain("Refresh failed");

    await until(() => (doc.body.textContent ?? "").includes("new event 1"));
    expect(tick?.hasAttribute("data-failed")).toBe(false);
    expect(doc.querySelector("[data-countdown]")?.textContent).not.toContain("failed");
    expect(tick?.getAttribute("title")).not.toContain("Refresh failed");
    expect(reloads).toEqual([]);
    expect(server.requests).toHaveLength(2);
  });

  test("REQ-003-28 a server error is a failed refresh too", async () => {
    const server: Server = { answers: [status(500)], requests: [] };
    const { doc, reloads } = open(page(snap("old")), server);
    const tick = doc.querySelector("[data-reload]");
    await until(() => tick?.hasAttribute("data-failed") === true);
    expect(tick?.getAttribute("title")).toContain("HTTP 500");
    expect(doc.body.textContent).toContain("old event 1");
    expect(reloads).toEqual([]);
  });

  test("REQ-003-28 a 401 reloads the whole page, so the Owner sees why", async () => {
    const server: Server = { answers: [status(401)], requests: [] };
    const { doc, reloads } = open(page(snap("old")), server);
    await until(() => reloads.length > 0);
    expect(server.requests).toEqual([URL_]);
    expect(doc.body.textContent).toContain("old event 1");
  });

  test("REQ-003-28 a page with other assets (the Coordinator was updated) reloads the whole page", async () => {
    const newer = page(snap("new")).replace(/dashboard\.js\?v=[0-9a-f]+/, "dashboard.js?v=0123456789");
    const server: Server = { answers: [ok(newer)], requests: [] };
    const { doc, reloads } = open(page(snap("old")), server);
    await until(() => reloads.length > 0);
    expect(server.requests).toEqual([URL_]);
    expect(doc.body.textContent).toContain("old event 1");
  });

  test("REQ-003-28 a hidden tab waits and refreshes once it is shown again", async () => {
    const server: Server = { answers: [ok(page(snap("new")))], requests: [] };
    const { w, doc } = open(page(snap("old")), server);
    Object.defineProperty(w.document, "hidden", { value: true, configurable: true });
    await Bun.sleep(1500);
    expect(server.requests).toEqual([]);
    Object.defineProperty(w.document, "hidden", { value: false, configurable: true });
    w.document.dispatchEvent(new w.Event("visibilitychange"));
    await until(() => (doc.body.textContent ?? "").includes("new event 1"));
    expect(server.requests).toHaveLength(1);
  });

  test('REQ-003-33 picking an issue or ticking "Include your time" on the Timings page shows it right away', () => {
    const html = renderTimings(
      dashboardView(snap("t"), config, NOW),
      timingsView({ source: MOCK_TIMING_SOURCE, pick: null, includeOwner: false, now: MOCK_NOW }),
    );
    const { doc } = open(html, { answers: [], requests: [] });
    const form = doc.querySelector("form[data-autosubmit]") as unknown as { requestSubmit: () => void } | null;
    expect(form).not.toBeNull();
    let submitted = 0;
    if (form) form.requestSubmit = () => submitted++;
    const change = (selector: string) =>
      doc
        .querySelector(selector)
        ?.dispatchEvent(new (doc.defaultView as unknown as Window).Event("change", { bubbles: true }));
    change('select[name="issue"]');
    change('input[name="owner"]');
    expect(submitted).toBe(2);
  });
});
