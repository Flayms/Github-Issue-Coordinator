/**
 * Spec 006: the Harness contract. The core cases run against every adapter; the optional ones only for adapters that
 * declare the feature (REQ-006-04). Codex cases use payloads recorded from Codex CLI 0.170.0 (test/fixtures/codex),
 * Copilot cases from Copilot CLI 1.0.114 (test/fixtures/copilot).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravity } from "../src/harness/antigravity.ts";
import { codexEndedTurn, copyRollout } from "../src/harness/codex.ts";
import { copilot } from "../src/harness/copilot.ts";
import {
  CORE_FEATURES,
  HARNESS_NAMES,
  HARNESSES,
  type LoginCheck,
  OPTIONAL_FEATURES,
  versionAtLeast,
} from "../src/harness/index.ts";
import { handleHook } from "../src/hook.ts";
import { HARNESS_MODELS, harnessOfModel } from "../src/models.ts";
import { resultInstructions } from "../src/results.ts";
import { Store } from "../src/store.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "codex");
const agyHooks = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "antigravity", "hooks.json"), "utf8"),
) as Record<string, Record<string, unknown>>;
const codexHooks = JSON.parse(readFileSync(join(FIXTURES, "hooks.json"), "utf8")) as Record<
  string,
  Record<string, unknown>
>;

const COPILOT_FIXTURES = join(import.meta.dir, "fixtures", "copilot");
const copilotHooks = JSON.parse(readFileSync(join(COPILOT_FIXTURES, "hooks.json"), "utf8")) as Record<
  string,
  Record<string, unknown>
>;

/** Runs a login check without a CLI: a command check gets a failed, empty answer. */
const loginOf = (check: LoginCheck, folder: string, env: Record<string, string | undefined> = {}) =>
  "readFolder" in check ? check.readFolder(folder, env) : check.read({ ok: false, out: "" });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

for (const name of HARNESS_NAMES) {
  const h = HARNESSES[name];
  describe(`${h.label} adapter (contract)`, () => {
    test("REQ-006-06 declares every core feature as supported, and each optional one either way", () => {
      for (const f of Object.keys(CORE_FEATURES)) expect(h.features[f as keyof typeof CORE_FEATURES].has).toBe(true);
      for (const f of Object.keys(OPTIONAL_FEATURES))
        expect(typeof h.features[f as keyof typeof OPTIONAL_FEATURES].has).toBe("boolean");
    });

    test("REQ-006-01 launches with skipped permissions, its model and the hooks of its turn end", () => {
      const sessionDir = join(dir, "s1");
      mkdirSync(sessionDir);
      const hook = (ev: string) => `'hook' '${ev}'`;
      const model = { model: "m-1", effort: "high" as const };
      h.writeSessionConfig({ sessionDir, cwd: "/work/app", home: dir, hook, model });
      const args = h.args({ sessionDir, name: "#5 x · Planner · app", model, hook });
      // The per-session config: the command line and every file the adapter wrote into the session folder.
      const files = readdirSync(sessionDir, { recursive: true, encoding: "utf8" })
        .map((f) => join(sessionDir, f))
        .filter((f) => statSync(f).isFile());
      const config = [args.join(" "), ...files.map((f) => readFileSync(f, "utf8"))].join("\n");
      expect(args.join(" ")).toMatch(
        /--dangerously-(skip-permissions|bypass-approvals-and-sandbox)|--allow-all\b|--auto\b/,
      );
      expect(args).toContain("m-1");
      // The effort, on the command line or in the session's config (OpenCode has no flag for it).
      expect(config).toContain("high");
      // Each hook the CLI fires, by the event the hook script handles it as (the Harness's own name may differ).
      const handled = [...config.matchAll(/'hook' '(\w+)'/g)].map(
        ([, ev = ""]) => h.hookInput?.(ev, { invocationNum: 0 })?.event ?? ev,
      );
      for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) expect(handled).toContain(ev);
    });

    test("REQ-006-03 resumes by the Harness's session id", () => {
      const args = h.args({ sessionDir: dir, name: "n", model: { model: "m" }, resumeId: "sess-9", hook: () => "h" });
      expect(args.slice(0, 2)).toContain("sess-9");
      expect(args.indexOf("sess-9")).toBeLessThan(2);
    });

    test("REQ-006-05 reads its login check", () => {
      if (!("readFolder" in h.loginCheck)) expect(h.loginCheck.args.length).toBeGreaterThan(0);
      expect(loginOf(h.loginCheck, join(dir, "no-login")).ok).toBe(false);
    });

    if (h.moveTranscript)
      test("REQ-006-04 transcriptMove: a session's transcript moves to another Account's folder", () => {
        const from = join(dir, "from");
        const to = join(dir, "to");
        const file =
          name === "claude"
            ? join(from, "projects", "-work-app", "sess-9.jsonl")
            : name === "copilot"
              ? join(from, "session-state", "sess-9", "events.jsonl")
              : join(from, "sessions", "2026", "11", "19", "rollout-2026-11-19T18-04-30-sess-9.jsonl");
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, "turns\n");
        expect(h.moveTranscript?.("sess-9", from, to)).toBe(true);
        expect(readFileSync(file.replace(from, to), "utf8")).toBe("turns\n");
        expect(h.moveTranscript?.("other", from, join(dir, "none"))).toBe(false);
      });

    test("REQ-006-01 its models in the Model catalogue run on it", () => {
      for (const m of HARNESS_MODELS[name]) expect(harnessOfModel(m.value)).toBe(name);
    });
  });
}

describe("Harness of a model", () => {
  test("REQ-006-01 a model outside the catalogue runs on Codex for OpenAI's names, else on Claude Code", () => {
    expect(harnessOfModel("gpt-6.2-sol")).toBe("codex");
    expect(harnessOfModel("gpt-7-nova")).toBe("codex");
    expect(harnessOfModel("o3")).toBe("codex");
    expect(harnessOfModel("opus")).toBe("claude");
    expect(harnessOfModel("opus[1m]")).toBe("claude");
    expect(harnessOfModel("claude-opus-5-5")).toBe("claude");
  });

  test("REQ-006-07 Gemini models run on Antigravity CLI", () => {
    expect(harnessOfModel("gemini-4-neon")).toBe("antigravity");
    expect(harnessOfModel("gemini-3.6-flash-medium")).toBe("antigravity");
  });

  test("REQ-006-14 an `opencode:` model runs on OpenCode, any provider's", () => {
    expect(harnessOfModel("opencode:opencode/big-pickle")).toBe("opencode");
    expect(harnessOfModel("opencode:anthropic/claude-sonnet-5-5")).toBe("opencode");
    expect(harnessOfModel("opencode:openai/gpt-6.2-sol")).toBe("opencode");
  });

  test("REQ-006-10 a `copilot:` model runs on Copilot CLI, also outside the catalogue", () => {
    expect(harnessOfModel("copilot:claude-sonnet-5.5")).toBe("copilot");
    expect(harnessOfModel("copilot:gpt-6.1-sol")).toBe("copilot");
    expect(harnessOfModel("copilot:gemini-4-argon")).toBe("copilot");
    expect(harnessOfModel("copilot:some-new-model")).toBe("copilot");
  });

  test("REQ-006-05 compares CLI versions", () => {
    expect(versionAtLeast("0.170.0", "0.170.0")).toBe(true);
    expect(versionAtLeast("0.171.2", "0.170.0")).toBe(true);
    expect(versionAtLeast("0.99.9", "0.170.0")).toBe(false);
    expect(versionAtLeast("2.1.328", "2.1.0")).toBe(true);
  });
});

describe("Codex CLI hooks (recorded payloads)", () => {
  let store: Store;
  let sessionDir: string;
  beforeEach(() => {
    store = new Store(join(dir, "state.db"));
    sessionDir = join(dir, "sessions", "1");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => store.close());
  const start = () =>
    store.createSession({ repo: "octo/app", role: "reviewer", kind: "issue", issues: [5], harness: "codex" });
  const fire = (event: string, payload: Record<string, unknown>) =>
    handleHook({ event, payload, store, sessionId: 1, sessionDir });

  test("REQ-006-01 SessionStart records Codex's session id, model and rollout", () => {
    start();
    fire("SessionStart", codexHooks.SessionStart as Record<string, unknown>);
    const s = store.session(1);
    expect(s?.agentSessionId).toBe("01a1f4fb-4535-7cb2-bc3c-78b9ba0a5a91");
    expect(s?.modelId).toBe("gpt-fake");
    expect(s?.transcriptPath).toEndWith("rollout-2026-11-19T18-04-30-01a1f4fb-4535-7cb2-bc3c-78b9ba0a5a91.jsonl");
  });

  test("REQ-006-01 Stop blocks the turn with the Result instructions while the Result is missing", () => {
    start();
    store.patchSession(1, { coordinatorPromptPending: false });
    const out = fire("Stop", codexHooks.Stop as Record<string, unknown>);
    expect(JSON.parse(out.stdout ?? "{}")).toMatchObject({ decision: "block" });
    expect(store.session(1)?.resultFailures).toBe(1);
  });

  test("REQ-006-01 Stop with a valid Result ends the turn", () => {
    start();
    writeFileSync(
      join(sessionDir, "result.json"),
      JSON.stringify({ summary: "ok", risk: "low", riskReason: "tiny", findings: [] }),
    );
    const out = fire("Stop", codexHooks.Stop as Record<string, unknown>);
    expect(out.stdout).toBeUndefined();
    expect(store.session(1)).toMatchObject({ state: "idle", needsSync: true });
  });
});

describe("Codex CLI usage limit (recorded rollout)", () => {
  test("REQ-006-04 / REQ-001-17 a turn that ended on the usage limit is found in the rollout", () => {
    expect(codexEndedTurn(join(FIXTURES, "rollout-usage-limit.jsonl"))).toEqual({ usageLimited: true });
  });

  test("REQ-006-04 a turn that ended normally, or is still running, is not", () => {
    const lines = readFileSync(join(FIXTURES, "rollout-usage-limit.jsonl"), "utf8").trim().split("\n");
    const normal = join(dir, "normal.jsonl");
    writeFileSync(normal, `${lines.slice(0, 8).join("\n")}\n`);
    expect(codexEndedTurn(normal)).toBeUndefined();
    const running = join(dir, "running.jsonl");
    writeFileSync(running, `${lines.join("\n")}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`);
    expect(codexEndedTurn(running)).toBeUndefined();
    expect(codexEndedTurn(join(dir, "missing.jsonl"))).toBeUndefined();
  });

  test("REQ-006-04 copyRollout copies nothing without a sessions folder", () => {
    expect(copyRollout("x", join(dir, "nowhere"), join(dir, "to"))).toBe(false);
  });
});

describe("Antigravity CLI launch", () => {
  const agyLogin = antigravity.loginCheck as Extract<LoginCheck, { args: string[] }>;
  const hook = (ev: string) => `'hook' '${ev}'`;
  const launch = (model: { model: string; effort?: "low" | "high" }, resumeId?: string) => {
    const sessionDir = join(dir, "s7");
    mkdirSync(sessionDir, { recursive: true });
    antigravity.writeSessionConfig({ sessionDir, cwd: join(dir, "work"), home: dir, hook });
    return { sessionDir, args: antigravity.args({ sessionDir, name: "n", model, resumeId, hook }) };
  };

  test("REQ-006-07 hooks and settings live in the session folder: nothing in the Worktree or the Account's folder", () => {
    mkdirSync(join(dir, "work"));
    const { sessionDir, args } = launch({ model: "gemini-4-neon" });
    expect(readdirSync(join(dir, "work"))).toEqual([]);
    expect(existsSync(join(dir, ".gemini"))).toBe(false);
    // Hooks load from a workspace folder's `.agents/hooks.json`; the session folder is added as one.
    expect(args.join(" ")).toContain(`--add-dir ${sessionDir}`);
    const hooks = JSON.parse(readFileSync(join(sessionDir, ".agents", "hooks.json"), "utf8"));
    expect(Object.keys(hooks.issueflow)).toEqual(["SessionStart", "PreInvocation", "Stop"]);
    expect(hooks.issueflow.Stop).toEqual([{ type: "command", command: "'hook' 'Stop'" }]);
    // REQ-005-01: no folder trust question (workspace hooks load only in trusted folders), no plan review wait.
    const settingsPath = args[args.indexOf("--settings") + 1] ?? "";
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
      trustedWorkspaces: [join(dir, "work"), sessionDir],
      artifactReviewPolicy: "always-proceed",
    });
    expect(args).toContain("--dangerously-skip-permissions");
    // The runner appends the prompt, which `-i` runs in the interactive session.
    expect(args.at(-1)).toBe("-i");
  });

  test("REQ-006-07 a Role's effort applies unless the model id names one; agy refuses both", () => {
    expect(launch({ model: "gemini-4-neon", effort: "high" }).args.join(" ")).toContain(
      "--model gemini-4-neon --effort high",
    );
    expect(launch({ model: "gemini-4-neon-low", effort: "high" }).args).not.toContain("--effort");
    expect(launch({ model: "gemini-4-neon" }).args).not.toContain("--effort");
  });

  test("REQ-006-07 a Feedback round resumes the conversation by id", () => {
    expect(launch({ model: "gemini-4-neon" }, "955778c7").args.slice(0, 2)).toEqual(["--conversation", "955778c7"]);
  });

  test("REQ-006-05 `agy models` is its login check", () => {
    expect(agyLogin.args).toEqual(["models"]);
    expect(
      agyLogin.read({
        ok: true,
        out: "Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)",
      }),
    ).toEqual({ ok: true, detail: "signed in" });
    expect(agyLogin.read({ ok: false, out: "Error: Please sign in to view available models." }).ok).toBe(false);
  });
});

describe("Antigravity CLI hooks (recorded payloads)", () => {
  let store: Store;
  let sessionDir: string;
  beforeEach(() => {
    store = new Store(join(dir, "state.db"), () => new Date("2026-11-19T12:00:00Z"));
    sessionDir = join(dir, "sessions", "1");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => store.close());
  const start = () =>
    store.createSession({ repo: "octo/app", role: "reviewer", kind: "issue", issues: [5], harness: "antigravity" });
  const fire = (event: string, fixture: string) =>
    handleHook({ event, payload: agyHooks[fixture] as Record<string, unknown>, store, sessionId: 1, sessionDir });
  const VALID = JSON.stringify({ summary: "ok", risk: "low", riskReason: "tiny", findings: [] });

  test("REQ-006-07 SessionStart records the conversation id, model and transcript", () => {
    start();
    fire("SessionStart", "SessionStart");
    expect(store.session(1)).toMatchObject({
      agentSessionId: "955778c7-0088-4753-8579-2e9f2d22eebd",
      modelId: "gemini-4-neon-high",
      transcriptPath:
        "/home/agent/.gemini/antigravity-cli/brain/955778c7-0088-4753-8579-2e9f2d22eebd/.system_generated/logs/transcript_full.jsonl",
    });
  });

  test("REQ-006-07 / REQ-001-19 a turn's first model call marks it running; a call after a blocked Stop is no new prompt", () => {
    start();
    // As the runner leaves it when it sends the Coordinator's prompt.
    store.patchSession(1, { coordinatorPromptPending: true });
    fire("PreInvocation", "PreInvocation");
    expect(store.session(1)).toMatchObject({
      state: "running",
      coordinatorPromptPending: false,
      ownerMessagedAt: null,
    });
    fire("PreInvocation", "PreInvocationAfterContinue");
    expect(store.session(1)?.ownerMessagedAt).toBeNull();
    fire("PreInvocation", "PreInvocation");
    expect(store.session(1)?.ownerMessagedAt).not.toBeNull();
  });

  test("REQ-006-07 Stop continues the turn with the Result instructions while the Result is missing", () => {
    start();
    const out = fire("Stop", "Stop");
    const decision = JSON.parse(out.stdout ?? "{}");
    // Antigravity re-enters the loop on "continue" and injects the reason; "block" would let it stop.
    expect(decision.decision).toBe("continue");
    expect(decision.reason).toContain("result.json");
    expect(store.session(1)?.resultFailures).toBe(1);
  });

  test("REQ-006-07 Stop with a valid Result ends the turn", () => {
    start();
    writeFileSync(join(sessionDir, "result.json"), VALID);
    expect(fire("Stop", "Stop").stdout).toBeUndefined();
    expect(store.session(1)).toMatchObject({ state: "idle", needsSync: true });
  });

  test("REQ-006-08 / REQ-001-17 a turn ended by the quota pauses the Account until the reported retry delay", () => {
    start();
    const out = fire("Stop", "StopUsageLimit");
    expect(out.stdout).toBeUndefined();
    expect(store.session(1)).toMatchObject({
      state: "idle",
      usageLimited: true,
      // retryDelay:11525s
      usageLimitResetsAt: "2026-11-19T15:12:05.000Z",
    });
    expect(store.session(1)?.resultFailures).toBe(0);
  });

  test("REQ-006-08 a quota error without a retry delay pauses for the default interval; other errors are no usage limit", () => {
    start();
    const noDelay = { ...agyHooks.StopUsageLimit, error: "Error 429, Status: RESOURCE_EXHAUSTED" };
    expect(antigravity.hookInput?.("Stop", noDelay, Date.parse("2026-11-19T12:00:00Z"))).toEqual({
      event: "StopFailure",
      payload: expect.objectContaining({ error: "rate_limit", resets_at: undefined }),
    });
    const other = { ...agyHooks.StopUsageLimit, error: "Error 500, Status: INTERNAL" };
    expect(antigravity.hookInput?.("Stop", other, Date.parse("2026-11-19T12:00:00Z"))?.event).toBe("Stop");
  });
});

describe("Copilot CLI hooks (recorded payloads)", () => {
  let store: Store;
  let sessionDir: string;
  beforeEach(() => {
    store = new Store(join(dir, "state.db"));
    sessionDir = join(dir, "sessions", "1");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => store.close());
  const start = (role: "reviewer" | "implementer" = "reviewer") =>
    store.createSession({ repo: "octo/app", role, kind: "issue", issues: [5], harness: "copilot" });
  const fire = (event: string, payload: Record<string, unknown>) =>
    handleHook({ event, payload, store, sessionId: 1, sessionDir });
  const fixture = (name: string) => copilotHooks[name] as Record<string, unknown>;

  test("REQ-006-10 SessionStart records Copilot's session id, on a start and on a resume", () => {
    start();
    fire("SessionStart", fixture("SessionStart"));
    expect(store.session(1)?.agentSessionId).toBe("29ca2f8f-d225-47ac-829b-bc8e93ce5e41");
    fire("SessionStart", fixture("SessionStartResume"));
    expect(store.session(1)?.agentSessionId).toBe("29ca2f8f-d225-47ac-829b-bc8e93ce5e41");
  });

  test("REQ-006-10 Stop blocks the turn with the Result instructions while the Result is missing", () => {
    start();
    store.patchSession(1, { coordinatorPromptPending: false });
    const out = fire("Stop", fixture("Stop"));
    expect(JSON.parse(out.stdout ?? "{}")).toMatchObject({ decision: "block" });
    expect(store.session(1)?.resultFailures).toBe(1);
  });

  test("REQ-006-10 Stop with a valid Result ends the turn", () => {
    start();
    writeFileSync(
      join(sessionDir, "result.json"),
      JSON.stringify({ summary: "ok", risk: "low", riskReason: "tiny", findings: [] }),
    );
    expect(fire("Stop", fixture("StopAfterBlock")).stdout).toBeUndefined();
    expect(store.session(1)).toMatchObject({ state: "idle", needsSync: true });
  });

  test("REQ-006-10 / REQ-001-19 the block reason Copilot sends back as a prompt is not the Owner's message", () => {
    start();
    // As the runner launches it: the first prompt is the Coordinator's.
    store.patchSession(1, { coordinatorPromptPending: true });
    fire("UserPromptSubmit", fixture("UserPromptSubmit"));
    const block = JSON.parse(fire("Stop", fixture("Stop")).stdout ?? "{}") as { reason: string };
    // Copilot CLI submits the reason of a blocked Stop as the next prompt, firing UserPromptSubmit with it.
    fire("UserPromptSubmit", { ...fixture("UserPromptSubmitAfterBlock"), prompt: block.reason });
    expect(store.session(1)).toMatchObject({ state: "running", ownerMessagedAt: null });
    // The reason ends with the Result instructions; a prompt that only mentions them is still the Owner's.
    fire("UserPromptSubmit", {
      ...fixture("UserPromptSubmit"),
      prompt: `${resultInstructions("reviewer", join(sessionDir, "result.json"))} Also, why?`,
    });
    expect(store.session(1)?.ownerMessagedAt).not.toBeNull();
  });

  test("REQ-006-12 / REQ-001-17 errorOccurred on a rate limit ends the turn and marks it for the Account's pause", () => {
    start();
    store.patchSession(1, { coordinatorPromptPending: false });
    fire("errorOccurred", fixture("errorOccurred"));
    expect(store.session(1)).toMatchObject({ state: "idle", usageLimited: true, usageLimitResetsAt: null });
  });

  test("REQ-006-12 errorOccurred on a quota (premium requests used up) is a usage limit too", () => {
    start();
    fire("errorOccurred", {
      ...fixture("errorOccurred"),
      error: { name: "Error", message: "quota_exceeded: You have no premium requests left." },
    });
    expect(store.session(1)?.usageLimited).toBe(true);
  });

  test("REQ-006-12 errorOccurred on another error, or outside a model call, leaves the session alone", () => {
    start();
    fire("errorOccurred", { ...fixture("errorOccurred"), error: { name: "Error", message: "socket hang up" } });
    fire("errorOccurred", { ...fixture("errorOccurred"), errorContext: "tool_execution" });
    expect(store.session(1)).toMatchObject({ state: "running", usageLimited: false });
  });

  test("REQ-006-10 SessionEnd changes nothing", () => {
    start();
    fire("SessionEnd", fixture("SessionEnd"));
    expect(store.session(1)?.state).toBe("running");
  });
});

describe("Copilot CLI login check", () => {
  const check = copilot.loginCheck as Extract<LoginCheck, { readFolder: unknown }>;

  test("REQ-006-13 a login stored in the Account's folder", () => {
    const home = join(dir, ".copilot-work");
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), readFileSync(join(COPILOT_FIXTURES, "config.jsonc")));
    expect(check.readFolder(home, {})).toEqual({ ok: true, detail: "octocat" });
  });

  test("REQ-006-13 a token in the environment, which Copilot prefers to a stored login", () => {
    expect(check.readFolder(join(dir, "none"), { GH_TOKEN: "x" })).toEqual({ ok: true, detail: "token in GH_TOKEN" });
  });

  test("REQ-006-13 no login: says how to log in", () => {
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "empty", "config.json"), '// managed\n{ "firstLaunchAt": "2026-11-19T19:48:19.217Z" }');
    const r = check.readFolder(join(dir, "empty"), {});
    expect(r.ok).toBe(false);
    expect(r.detail).toStartWith("run it with the `login` subcommand");
  });
});
