import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { Cancelled, type Prompter } from "../src/init/prompter.ts";
import { machineInitEnv } from "../src/init/run.ts";
import { guessSetup, type InitEnv, init } from "../src/init/wizard.ts";

const CONFIG = "/home/o/.config/github-issue-coordinator/config.json";
const STATE = "/home/o/.local/share/github-issue-coordinator";
const SCHEMA = "file:///pkg/config.schema.json";

type Asked = { kind: string; message: string; initial?: unknown; options?: unknown[] };
/** An answer: a value, or `cancel` to press Ctrl-C there. */
type Answer = unknown;

/**
 * A Prompter answering from `answers`: the first key that the question's message contains wins, and a list gives one
 * answer per time it is asked. An unanswered question takes its preselected value, like pressing Enter.
 */
const scripted = (answers: [string, Answer][]) => {
  const asked: Asked[] = [];
  const shown: string[] = [];
  const used = new Map<string, number>();
  const answer = (q: Asked) => {
    asked.push(q);
    const hit = answers.find(([key]) => q.message.includes(key));
    if (!hit) return q.initial;
    const [key, value] = hit;
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const v = Array.isArray(value) && value[0] === "each" ? value[n + 1] : value;
    if (v === "cancel") throw new Cancelled();
    return v === undefined ? q.initial : v;
  };
  const p: Prompter = {
    intro: (t) => shown.push(t),
    note: (m, t) => shown.push(`${t ?? ""}\n${m}`),
    info: (m) => shown.push(m),
    outro: (m) => shown.push(m),
    text: async (o) => {
      const v = String(answer({ kind: "text", message: o.message, initial: o.initial ?? "" }) ?? "");
      const error = o.validate?.(v);
      if (error) throw new Error(`invalid answer to "${o.message}": ${error}`);
      return v;
    },
    password: async (o) => {
      const v = String(answer({ kind: "password", message: o.message }) ?? "");
      const error = o.validate?.(v);
      if (error) throw new Error(`invalid answer to "${o.message}": ${error}`);
      return v;
    },
    confirm: async (o) => Boolean(answer({ kind: "confirm", message: o.message, initial: o.initial ?? false })),
    select: async (o) =>
      answer({
        kind: "select",
        message: o.message,
        initial: o.initial,
        options: o.options.map((c) => c.value),
      }) as never,
    multiselect: async (o) =>
      answer({
        kind: "multiselect",
        message: o.message,
        initial: o.initial ?? [],
        options: o.options.map((c) => c.value),
      }) as never,
  };
  return { p, asked, shown: () => shown.join("\n"), find: (m: string) => asked.find((a) => a.message.includes(m)) };
};

/** A fake machine: files with their modes, a `gh` that knows one user and some repositories. */
const fakeEnv = (
  o: { loggedIn?: boolean; loginWorks?: (token: string) => boolean; files?: Record<string, string> } = {},
) => {
  const files = new Map<string, { text: string; mode?: number }>(
    Object.entries(o.files ?? {}).map(([k, v]) => [k, { text: v }]),
  );
  let loggedIn = o.loggedIn ?? true;
  const calls: string[] = [];
  const env: InitEnv = {
    ghLoggedIn: () => loggedIn,
    ghLogin: (token) => {
      calls.push(`gh login ${token}`);
      loggedIn = o.loginWorks?.(token) ?? true;
      return { ok: loggedIn, out: loggedIn ? "" : "HTTP 401: Bad credentials" };
    },
    ghUser: async (login) => (login === "else" ? { login: "else", id: 7 } : { login: "octo", id: 42 }),
    ghRepos: async () => ["octo/app", "octo/lib", "octo/web"],
    rootFiles: async (repo) =>
      repo === "octo/app" ? ["bun.lock", "package.json"] : repo === "octo/web" ? ["pnpm-lock.yaml"] : [],
    readFile: (path) => files.get(path)?.text,
    writeFile: (path, text, mode) => {
      files.set(path, { text, mode });
    },
    randomToken: () => "random-token",
    doctor: async (path) => {
      calls.push(`doctor ${path}`);
      return 0;
    },
    serviceInstall: async (path) => {
      calls.push(`service install ${path}`);
      return 0;
    },
    schemaUrl: SCHEMA,
    home: "/home/o",
    defaultStateDir: STATE,
  };
  return { env, files, calls, json: () => JSON.parse(files.get(CONFIG)?.text ?? "null") };
};

const FRESH: [string, Answer][] = [
  ["Which repositories", ["octo/app", "octo/lib"]],
  ["octo/lib: command", "make deps"],
  ["Implementer: effort", "medium"],
  ["dashboard's address", "https://coordinator.tail1234.ts.net"],
  ["client id", "Ov23liClient"],
  ["client secret", "s3cret"],
  ["dashboard token", true],
  ["Add extra Claude Code Accounts", true],
  ["Name of the extra Account", ["each", "spare", ""]],
  ["What should the Coordinator merge", "all"],
  ["Install and start", true],
];

describe("coordinator init", () => {
  test("REQ-007-08 a fresh setup asks the questions with the defaults preselected and writes a valid config", async () => {
    const m = fakeEnv();
    const s = scripted(FRESH);
    expect(await init(CONFIG, s.p, m.env)).toBe(0);

    // Owner from the token's account; setup guessed from the lockfile; Role defaults preselected.
    expect(s.find("The Owner")).toMatchObject({ kind: "confirm", initial: true });
    expect(s.find("The Owner")?.message).toContain("octo (id 42)");
    expect(s.find("Which repositories")?.options).toEqual(["octo/app", "octo/lib", "octo/web"]);
    expect(s.find("octo/app: command")?.initial).toBe("bun install");
    expect(s.find("octo/lib: command")?.initial).toBe("");
    expect(s.find("Planner: model")?.initial).toBe("opus");
    expect(s.find("Planner: effort")?.initial).toBe("high");
    expect(s.find("Implementer: model")?.initial).toBe("sonnet");
    expect(s.find("Implementer: effort")?.initial).toBe("");
    expect(s.find("Reviewer: model")?.options).toContain("claude-opus-5-5");
    expect(s.find("What should the Coordinator merge")).toMatchObject({
      initial: "evaluated",
      options: ["evaluated", "off", "all"],
    });
    // The exact URLs to register in the OAuth App.
    expect(s.shown()).toContain("Homepage URL                https://coordinator.tail1234.ts.net\n");
    expect(s.shown()).toContain("Authorization callback URL  https://coordinator.tail1234.ts.net/auth/callback");
    // The login step for the extra Account.
    expect(s.shown()).toContain("CLAUDE_CONFIG_DIR=/home/o/.claude-spare claude    then /login");

    const json = m.json();
    expect(json).toEqual({
      $schema: SCHEMA,
      owner: { login: "octo", id: 42 },
      repos: [
        { name: "octo/app", setup: "bun install" },
        { name: "octo/lib", setup: "make deps" },
      ],
      roles: {
        planner: { model: "opus", effort: "high" },
        implementer: { model: "sonnet", effort: "medium" },
        reviewer: { model: "opus" },
      },
      autoMerge: "all",
      accounts: [{ name: "main" }, { name: "spare", configDir: "/home/o/.claude-spare" }],
      dashboard: {
        githubLogin: { clientId: "Ov23liClient", clientSecretPath: `${STATE}/github-client-secret` },
        tokenPath: `${STATE}/dashboard-token`,
      },
    });
    expect(() => parseConfig(json, { configPath: CONFIG })).not.toThrow();
    expect(m.files.get(CONFIG)?.text).toBe(`${JSON.stringify(json, null, 2)}\n`);
    // Then the setup check and the service.
    expect(m.calls).toEqual([`doctor ${CONFIG}`, `service install ${CONFIG}`]);
  });

  test("REQ-007-10 the client secret and the token are files only the user can read; the config holds their paths", async () => {
    const m = fakeEnv();
    await init(CONFIG, scripted(FRESH).p, m.env);
    expect(m.files.get(`${STATE}/github-client-secret`)).toEqual({ text: "s3cret\n", mode: 0o600 });
    expect(m.files.get(`${STATE}/dashboard-token`)).toEqual({ text: "random-token\n", mode: 0o600 });
    expect(m.files.get(CONFIG)?.text).not.toContain("s3cret");
    expect(m.files.get(CONFIG)?.text).not.toContain("random-token");
  });

  test("REQ-007-10 the machine writes a secret with mode 600 and the config readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "init-"));
    dirs.push(dir);
    const env = machineInitEnv();
    env.writeFile(join(dir, "state", "secret"), "x\n", 0o600);
    env.writeFile(join(dir, "config", "config.json"), "{}\n");
    expect(statSync(join(dir, "state", "secret")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, "config", "config.json"), "utf8")).toBe("{}\n");
    expect(env.readFile(join(dir, "missing"))).toBeUndefined();
    expect(env.schemaUrl).toMatch(/^file:\/\/.*\/config\.schema\.json$/);
  });

  test("REQ-007-08 without a GitHub CLI login it explains the PAT and logs in with the pasted token", async () => {
    const m = fakeEnv({ loggedIn: false, loginWorks: (t) => t === "github_pat_good" });
    const s = scripted([["Paste the token", ["each", "github_pat_bad", " github_pat_good "]], ...FRESH]);
    expect(await init(CONFIG, s.p, m.env)).toBe(0);
    expect(s.shown()).toContain("Read & write        Contents, Issues, Pull requests, Workflows");
    expect(s.find("Paste the token")?.kind).toBe("password");
    expect(m.calls.slice(0, 2)).toEqual(["gh login github_pat_bad", "gh login github_pat_good"]);
    expect(s.shown()).toContain("gh auth login failed: HTTP 401: Bad credentials");
  });

  test("REQ-007-08 an Owner other than the token's account is looked up by login", async () => {
    const m = fakeEnv();
    const s = scripted([["The Owner, the only", false], ["The Owner's GitHub login", "else"], ...FRESH]);
    await init(CONFIG, s.p, m.env);
    expect(m.json().owner).toEqual({ login: "else", id: 7 });
  });

  test("REQ-007-08 the dashboard can be off; then no OAuth App or token is asked for", async () => {
    const m = fakeEnv();
    const s = scripted([["The web dashboard", "off"], ...FRESH]);
    await init(CONFIG, s.p, m.env);
    expect(m.json().dashboard).toBe(false);
    expect(s.find("client id")).toBeUndefined();
    expect(s.find("dashboard token")).toBeUndefined();
    expect([...m.files.keys()]).toEqual([CONFIG]);
  });

  test("REQ-007-08 cancelling at any question writes nothing; declining the service says how to install it later", async () => {
    for (const at of ["Which repositories", "client secret", "What should the Coordinator merge"]) {
      const m = fakeEnv();
      const s = scripted([[at, "cancel"], ...FRESH]);
      expect(await init(CONFIG, s.p, m.env)).toBe(1);
      expect(m.files.size).toBe(0);
      expect(s.shown()).toContain("Cancelled; nothing was written.");
    }
    const m = fakeEnv();
    const s = scripted([["Install and start", false], ...FRESH]);
    expect(await init(CONFIG, s.p, m.env)).toBe(0);
    expect(m.calls).toEqual([`doctor ${CONFIG}`]);
    expect(s.shown()).toContain("sudo coordinator service install");
  });

  test("REQ-007-08 setup commands are guessed from the lockfile", () => {
    expect(guessSetup(["bun.lock"])).toBe("bun install");
    expect(guessSetup(["bun.lockb"])).toBe("bun install");
    expect(guessSetup(["pnpm-lock.yaml", "package.json"])).toBe("pnpm install");
    expect(guessSetup(["yarn.lock"])).toBe("yarn install");
    expect(guessSetup(["package-lock.json"])).toBe("npm ci");
    expect(guessSetup(["uv.lock"])).toBe("uv sync");
    expect(guessSetup(["go.sum"])).toBe("go mod download");
    expect(guessSetup(["Cargo.lock"])).toBe("cargo fetch");
    expect(guessSetup(["README.md"])).toBeUndefined();
  });
});

const EXISTING = {
  $schema: "file:///old/config.schema.json",
  owner: { login: "octo", id: 42 },
  pollIntervalSec: 30,
  limits: { maxRunning: 2, maxLiveSessions: 3 },
  roles: {
    planner: { model: "opus[1m]" },
    implementer: { model: "sonnet", effort: "low" },
    reviewer: { model: "haiku" },
  },
  instructions: { planner: "Keep it short." },
  repos: [{ name: "octo/web", setup: "pnpm install", roles: { reviewer: { model: "opus" } } }],
  autoMerge: "off",
  dashboard: {
    port: 9090,
    githubLogin: { clientId: "Ov23liOld", clientSecretPath: "/secrets/client" },
    tokenPath: "/secrets/token",
  },
};

describe("coordinator init on an existing config", () => {
  const existing = () =>
    fakeEnv({
      files: { [CONFIG]: JSON.stringify(EXISTING), "/secrets/client": "old\n", "/secrets/token": "tok\n" },
    });

  test("REQ-007-09 it asks before touching the file; Stop changes nothing", async () => {
    const m = existing();
    const s = scripted([["exists", "stop"]]);
    expect(await init(CONFIG, s.p, m.env)).toBe(0);
    expect(s.find("exists")).toMatchObject({ kind: "select", initial: "edit", options: ["edit", "new", "stop"] });
    expect(m.files.get(CONFIG)?.text).toBe(JSON.stringify(EXISTING));
    expect(s.asked).toHaveLength(1);
  });

  test("REQ-007-09 editing preselects the file's values and keeps what init doesn't ask about", async () => {
    const m = existing();
    const s = scripted([
      ["exists", "edit"],
      ["Which repositories", ["octo/web", "octo/app"]],
    ]);
    expect(await init(CONFIG, s.p, m.env)).toBe(0);
    expect(s.find("Which repositories")?.initial).toEqual(["octo/web"]);
    expect(s.find("octo/web: command")?.initial).toBe("pnpm install");
    expect(s.find("octo/app: command")?.initial).toBe("bun install");
    expect(s.find("Planner: model")).toMatchObject({ initial: "opus[1m]" });
    expect(s.find("Planner: model")?.options?.[0]).toBe("opus[1m]");
    expect(s.find("Planner: effort")?.initial).toBe("");
    expect(s.find("Implementer: effort")?.initial).toBe("low");
    expect(s.find("Reviewer: model")?.initial).toBe("haiku");
    expect(s.find("The web dashboard")?.initial).toBe("github");
    expect(s.find("dashboard's address")?.initial).toBe("http://127.0.0.1:9090");
    expect(s.find("client id")?.initial).toBe("Ov23liOld");
    expect(s.find("client secret")?.message).toContain("empty: keep the saved one");
    expect(s.find("dashboard token")?.initial).toBe(true);
    expect(s.find("What should the Coordinator merge")?.initial).toBe("off");

    const json = m.json();
    expect(Object.keys(json)).toEqual(Object.keys(EXISTING));
    expect(json).toEqual({
      ...EXISTING,
      $schema: SCHEMA,
      repos: [
        { name: "octo/web", setup: "pnpm install", roles: { reviewer: { model: "opus" } } },
        { name: "octo/app", setup: "bun install" },
      ],
    });
    // REQ-007-10: the secret and the token files stay as they were.
    expect(m.files.get("/secrets/client")?.text).toBe("old\n");
    expect(m.files.get("/secrets/token")?.text).toBe("tok\n");
  });

  test("REQ-007-10 a new client secret replaces the old file's content in the state folder", async () => {
    const m = existing();
    await init(
      CONFIG,
      scripted([
        ["exists", "edit"],
        ["client secret", "new-secret"],
      ]).p,
      m.env,
    );
    expect(m.json().dashboard.githubLogin.clientSecretPath).toBe(`${STATE}/github-client-secret`);
    expect(m.files.get(`${STATE}/github-client-secret`)).toEqual({ text: "new-secret\n", mode: 0o600 });
  });

  test("REQ-007-09 a file that isn't JSON can only be replaced or kept", async () => {
    const m = fakeEnv({ files: { [CONFIG]: "{ broken" } });
    const s = scripted([["exists", "new"], ...FRESH]);
    expect(await init(CONFIG, s.p, m.env)).toBe(0);
    expect(s.find("exists")).toMatchObject({ initial: "stop", options: ["new", "stop"] });
    expect(m.json().owner).toEqual({ login: "octo", id: 42 });
  });
});

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
