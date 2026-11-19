import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigInput, parseConfig } from "../src/config.ts";
import type { TickSnapshot } from "../src/coordinator.ts";
import { type DashboardServer, loadDashboardToken, startDashboard } from "../src/dashboard/server.ts";
import type { TimingSource } from "../src/dashboard/timings.ts";
import { Store } from "../src/store.ts";

const base: ConfigInput = {
  owner: { login: "octo", id: 42 },
  roles: { planner: { model: "opus" }, implementer: { model: "sonnet" }, reviewer: { model: "opus" } },
  repos: [{ name: "octo/app" }],
};
const TOKEN = "s3cret-token-value";

const snap: TickSnapshot = {
  finishedAt: "2026-11-15T10:00:00.000Z",
  pausedUntil: null,
  accounts: [],
  repos: [
    {
      repo: "octo/app",
      error: null,
      issues: [{ number: 5, title: "Fix login", labels: ["agent:proposed"], blockedBy: [] }],
      pulls: [],
      worktrees: 0,
    },
  ],
  sessions: [],
  queue: [],
  events: [],
};

let servers: DashboardServer[] = [];
afterEach(() => {
  for (const s of servers) s.stop();
  servers = [];
});

const start = (opts: {
  dashboard?: ConfigInput["dashboard"];
  token?: string;
  snapshot?: () => TickSnapshot;
  timings?: TimingSource;
}) => {
  const logs: string[] = [];
  const calls = { snapshot: 0 };
  // These tests are about the token; the GitHub sign-in (on by default) has its own tests below.
  const dashboard = opts.dashboard ? { githubLogin: false as const, ...opts.dashboard } : opts.dashboard;
  const config = parseConfig({ ...base, ...(dashboard !== undefined ? { dashboard } : {}) });
  const server = startDashboard({
    config,
    token: opts.token,
    snapshot: () => {
      calls.snapshot++;
      return (opts.snapshot ?? (() => snap))();
    },
    log: (m) => logs.push(m),
    now: () => new Date("2026-11-15T10:01:00Z"),
    timings: opts.timings,
  });
  if (server) servers.push(server);
  return { server, logs, calls, url: server ? `http://127.0.0.1:${server.port}` : "" };
};

describe("dashboard server", () => {
  test("REQ-003-07 with `dashboard: false` no server is started and nothing is logged", () => {
    const { server, logs } = start({ dashboard: false });
    expect(server).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("REQ-003-07 without a dashboard block the server starts on 127.0.0.1:8080", () => {
    const config = parseConfig(base);
    const seen: { hostname?: string; port?: string | number }[] = [];
    const serve = Bun.serve;
    // Records what would be bound, then binds a free port: the test cannot rely on 8080 being free.
    Bun.serve = ((o: Parameters<typeof Bun.serve>[0] & { hostname?: string; port?: string | number }) => {
      seen.push({ hostname: o.hostname, port: o.port });
      return serve({ ...o, port: 0 } as Parameters<typeof Bun.serve>[0]);
    }) as typeof Bun.serve;
    const logs: string[] = [];
    try {
      const server = startDashboard({ config, snapshot: () => snap, log: (m) => logs.push(m) });
      if (server) servers.push(server);
      expect(server).toBeDefined();
    } finally {
      Bun.serve = serve;
    }
    expect(seen).toEqual([{ hostname: "127.0.0.1", port: 8080 }]);
    expect(logs[0]).toStartWith("dashboard on http://127.0.0.1:");
  });

  test("REQ-003-07 listens on 127.0.0.1 by default and serves the page", async () => {
    const { server, url } = start({ dashboard: { port: 0 } });
    expect(server?.hostname).toBe("127.0.0.1");
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("Fix login");
  });

  test("REQ-003-07 with a token, requests without it get 401 and no content", async () => {
    const { url, calls } = start({ dashboard: { port: 0, tokenPath: "/t" }, token: TOKEN });
    const inits: RequestInit[] = [
      {},
      { headers: { authorization: "Bearer wrong" } },
      { headers: { cookie: "coordinator_dashboard=wrong" } },
    ];
    for (const init of inits) {
      const res = await fetch(`${url}/`, init);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("Fix login");
    }
    const wrongQuery = await fetch(`${url}/?token=wrong`, { redirect: "manual" });
    expect(wrongQuery.status).toBe(401);
    expect(wrongQuery.headers.get("set-cookie")).toBeNull();
    expect(calls.snapshot).toBe(0);
  });

  test("REQ-003-07 the token works as a bearer header, and once in the address it is kept in a cookie", async () => {
    const { url } = start({ dashboard: { port: 0, tokenPath: "/t" }, token: TOKEN });
    const bearer = await fetch(`${url}/`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bearer.status).toBe(200);

    const first = await fetch(`${url}/?token=${TOKEN}`, { redirect: "manual" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/");
    const cookie = first.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`coordinator_dashboard=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const again = await fetch(`${url}/`, { headers: { cookie: `other=1; coordinator_dashboard=${TOKEN}` } });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Fix login");
  });

  test("REQ-003-07 answers only GET; other methods and paths change nothing", async () => {
    const { url, calls } = start({ dashboard: { port: 0, tokenPath: "/t" }, token: TOKEN });
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const res = await fetch(`${url}/`, { method, headers: auth });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    expect((await fetch(`${url}/settings`, { headers: auth })).status).toBe(404);
    expect(calls.snapshot).toBe(0);
    expect((await fetch(`${url}/`, { method: "POST" })).status).toBe(401); // the token is checked first
  });

  test("REQ-003-07 refuses to start with an empty or unreadable token file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-"));
    try {
      const path = join(dir, "token");
      writeFileSync(path, "  \n");
      const config = (tokenPath: string) => parseConfig({ ...base, dashboard: { tokenPath } });
      expect(() => loadDashboardToken(config(path))).toThrow("dashboard token file is empty");
      expect(() => loadDashboardToken(config(join(dir, "missing")))).toThrow("cannot read the dashboard token");
      writeFileSync(path, `${TOKEN}\n`);
      expect(loadDashboardToken(config(path))).toBe(TOKEN);
      expect(loadDashboardToken(parseConfig(base))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-003-08 an exception while rendering gives 500, is logged, and the next request is served", async () => {
    let fail = true;
    const { url, logs } = start({
      dashboard: { port: 0 },
      snapshot: () => {
        if (fail) throw new Error("boom");
        return snap;
      },
    });
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("boom");
    expect(logs.join("\n")).toContain("boom");
    fail = false;
    expect((await fetch(`${url}/`)).status).toBe(200);
  });

  test("REQ-003-08 / REQ-003-42 / REQ-003-43 the Overview reads a session's transcript and changes nothing in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-transcript-"));
    try {
      const path = join(dir, "abc.jsonl");
      const lines = [
        { type: "system", subtype: "bridge_status", url: "https://claude.ai/code/session_01Live" },
        {
          type: "assistant",
          timestamp: "2026-11-15T10:00:48.000Z",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] },
        },
      ];
      writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      const before = readFileSync(path, "utf8");
      const session = {
        id: 1,
        repo: "octo/app",
        role: "implementer" as const,
        kind: "issue" as const,
        issues: [5],
        claudeSessionId: "abc",
        state: "running" as const,
        resumeAttempts: 0,
        lastActivityAt: "2026-11-15T10:00:00.000Z",
        ownerMessagedAt: null,
        coordinatorPromptPending: false,
        resultFailures: 0,
        needsSync: false,
        usageLimited: false,
        modelId: null,
        title: "Fix login",
        startedAt: "2026-11-15T09:00:00.000Z",
        account: null,
        transcriptPath: path,
        live: true,
      };
      const { url } = start({ dashboard: { port: 0 }, snapshot: () => ({ ...snap, sessions: [session] }) });
      const html = await (await fetch(`${url}/`)).text();
      expect(html).toContain('data-now="Tool"');
      expect(html).toContain("Bash · bun test");
      expect(html).toContain("12 s ago");
      expect(html).toContain('href="https://claude.ai/code/session_01Live"');
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("REQ-003-08 a server that cannot listen is logged instead of stopping the Coordinator", () => {
    const first = start({ dashboard: { port: 0 } });
    const second = start({ dashboard: { port: first.server?.port } });
    expect(second.server).toBeUndefined();
    expect(second.logs.join("\n")).toContain("dashboard not started");
  });

  test("REQ-003-08 without a dashboard block, a taken default port is logged instead of stopping the Coordinator", () => {
    const config = parseConfig(base);
    const serve = Bun.serve;
    // Bun.serve throws like this when the port is taken; the test cannot occupy 8080 itself.
    Bun.serve = (() => {
      throw new Error("Failed to start server. Is port 8080 in use?");
    }) as typeof Bun.serve;
    const logs: string[] = [];
    try {
      expect(startDashboard({ config, snapshot: () => snap, log: (m) => logs.push(m) })).toBeUndefined();
    } finally {
      Bun.serve = serve;
    }
    expect(logs).toEqual(["dashboard not started: Failed to start server. Is port 8080 in use?"]);
  });

  test("REQ-003-05 serves the Config page at /config", async () => {
    const { url } = start({ dashboard: { port: 0 } });
    const res = await fetch(`${url}/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("Polling 1 repository every 60 s");
    expect(html).not.toContain("Fix login");
  });

  test("REQ-003-34 serves the Timings page at /timings from the store, behind the same token as the Overview", async () => {
    const store = new Store(":memory:", () => new Date("2026-11-15T10:00:00Z"));
    try {
      store.beginStep("octo/app", 5, {
        phase: "planning",
        role: "planner",
        title: "Fix login",
        queuedAt: "2026-11-15T09:46:00Z",
      });
      store.beginStep("octo/app", 6, { phase: "planning", role: "planner", queuedAt: "2026-11-15T09:00:00Z" });
      const { url } = start({ dashboard: { port: 0, tokenPath: "/x" }, token: TOKEN, timings: store });
      expect((await fetch(`${url}/timings`)).status).toBe(401);
      const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
      const res = await fetch(`${url}/timings?issue=${encodeURIComponent("octo/app#5")}&owner=1`, auth);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain("Waited for the Planner");
      expect(html).toContain(">14 min<");
      expect(html).toContain("end to end");
      expect(await (await fetch(`${url}/timings`, auth)).text()).toContain("octo/app#5 Fix login");
      expect(store.timedIssues()).toHaveLength(2); // read, nothing written
      expect(store.timings("octo/app", 5)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("REQ-003-34 without a Timings source the page says nothing is recorded", async () => {
    const { url } = start({ dashboard: { port: 0 } });
    const html = await (await fetch(`${url}/timings`)).text();
    expect(html).toContain("No Timings recorded yet");
  });

  test("REQ-003-13 ?repo= narrows the Pipeline", async () => {
    const two: TickSnapshot = {
      ...snap,
      repos: [
        ...snap.repos,
        {
          repo: "octo/lib",
          error: null,
          issues: [{ number: 2, title: "Lib thing", labels: [], blockedBy: [] }],
          pulls: [],
          worktrees: 0,
        },
      ],
    };
    const logs: string[] = [];
    const server = startDashboard({
      config: parseConfig({
        ...base,
        repos: [{ name: "octo/app" }, { name: "octo/lib" }],
        dashboard: { port: 0, githubLogin: false },
      }),
      snapshot: () => two,
      log: (m) => logs.push(m),
    });
    if (server) servers.push(server);
    const html = await (await fetch(`http://127.0.0.1:${server?.port}/?repo=octo%2Flib`)).text();
    // The Pipeline is narrowed; Your move above it lists what needs the Owner in every repository (REQ-003-32).
    const pipeline = html.slice(html.indexOf('id="pipeline"'));
    expect(pipeline).toContain("Lib thing");
    expect(pipeline).not.toContain("Fix login");
  });

  test("REQ-003-09 serves the CSS, script and fonts from a fixed list of files, behind the token", async () => {
    const { url, calls } = start({ dashboard: { port: 0, tokenPath: "/t" }, token: TOKEN });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const types: Record<string, string> = {
      "/assets/dashboard.css?v=1": "text/css; charset=utf-8",
      "/assets/dashboard.js": "text/javascript; charset=utf-8",
      "/assets/meters.js": "text/javascript; charset=utf-8",
      "/assets/fonts/inter.woff2": "font/woff2",
      "/assets/fonts/plus-jakarta-sans.woff2": "font/woff2",
      "/assets/fonts/jetbrains-mono.woff2": "font/woff2",
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await fetch(`${url}${path}`, { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
    }
    expect((await fetch(`${url}/assets/dashboard.css`)).status).toBe(401);
    for (const path of [
      "/assets/server.ts",
      "/assets/%2e%2e/server.ts",
      "/assets/fonts/..%2f..%2fserver.ts",
      "/assets/fonts/OFL-inter.txt",
      "/assets/",
    ]) {
      expect((await fetch(`${url}${path}`, { headers: auth })).status).toBe(404);
    }
    expect(calls.snapshot).toBe(0);
  });

  test("REQ-003-09 / REQ-003-28 the page loads nothing from elsewhere, runs only its own script, fetches only itself and cannot be framed", async () => {
    const { url } = start({ dashboard: { port: 0 } });
    for (const path of ["/", "/config", "/assets/dashboard.css", "/nope"]) {
      const res = await fetch(`${url}${path}`);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // REQ-003-28: the script may fetch the page's own URL, and nothing else.
      expect(csp).toContain("connect-src 'self';");
      expect(csp.split(";").map((d) => d.trim().split(" ")[0])).toEqual([
        "default-src",
        "script-src",
        "style-src",
        "font-src",
        "connect-src",
        "frame-ancestors",
        "form-action",
        "base-uri",
      ]);
      expect(csp).not.toContain("unsafe");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      if (!path.startsWith("/assets/")) expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
