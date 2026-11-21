/**
 * Spec 006, OpenCode (#182): its launch, the hook payloads its plugin sends (test/fixtures/opencode/hooks.json, recorded
 * from OpenCode 1.19.6 against the fake model server), and the generated plugin itself, run here with a fake OpenCode
 * client and fake OpenCode events shaped like OpenCode 1.19.6's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginCheck } from "../src/harness/index.ts";
import { OPENCODE_LIMIT_RETRIES, opencode, opencodePlugin } from "../src/harness/opencode.ts";
import { handleHook } from "../src/hook.ts";
import { Store } from "../src/store.ts";

const hooks = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "opencode", "hooks.json"), "utf8")) as Record<
  string,
  Record<string, unknown>
>;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("OpenCode launch", () => {
  const hook = (ev: string) => `'hook' '${ev}'`;
  const launch = (model: { model: string; effort?: "low" | "high" }, resumeId?: string) => {
    const sessionDir = join(dir, "s7");
    mkdirSync(sessionDir, { recursive: true });
    opencode.writeSessionConfig({ sessionDir, cwd: join(dir, "work"), home: dir, hook, model });
    const config = JSON.parse(readFileSync(join(sessionDir, "opencode", "opencode.json"), "utf8"));
    return { sessionDir, config, args: opencode.args({ sessionDir, name: "n", model, resumeId, hook }) };
  };

  test("REQ-006-14 the config and the plugin live in a config folder of the session's: nothing in the Worktree or the user's config", () => {
    mkdirSync(join(dir, "work"));
    const { sessionDir, config, args } = launch({ model: "opencode:opencode/big-pickle" });
    expect(readdirSync(join(dir, "work"))).toEqual([]);
    expect(existsSync(join(dir, ".config"))).toBe(false);
    expect(opencode.env({ tmp: join(sessionDir, "tmp"), sessionDir })).toEqual({
      OPENCODE_CONFIG_DIR: join(sessionDir, "opencode"),
    });
    // REQ-005-01: every permission allowed, by the config and `--auto`.
    expect(config).toMatchObject({ permission: "allow", share: "disabled", autoupdate: false });
    expect(config.agent).toBeUndefined();
    // The model without the catalogue's prefix; the runner appends the prompt after `--prompt`.
    expect(args).toEqual(["--mini", "--auto", "--model", "opencode/big-pickle", "--prompt"]);
    // OpenCode loads `plugins/*.js` of the config folder.
    const plugin = readFileSync(join(sessionDir, "opencode", "plugins", "issueflow.js"), "utf8");
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "session.status"])
      expect(plugin).toContain(JSON.stringify(hook(ev)));
  });

  test("REQ-006-14 a Role's effort is the model's variant, through the default agent with the same model", () => {
    const { config, args } = launch({ model: "opencode:anthropic/claude-sonnet-5-5", effort: "high" });
    expect(config.agent).toEqual({ build: { model: "anthropic/claude-sonnet-5-5", variant: "high" } });
    expect(args).toContain("anthropic/claude-sonnet-5-5");
  });

  test("REQ-006-14 a Feedback round resumes the session by its id, never the latest one", () => {
    const { args } = launch({ model: "opencode:opencode/big-pickle" }, "ses_e06d8aa75ffeTJsuqaLTkpifOS");
    expect(args.slice(0, 2)).toEqual(["--session", "ses_e06d8aa75ffeTJsuqaLTkpifOS"]);
    expect(args).not.toContain("--continue");
    // `--mini`, since the full TUI ignores `--prompt` when it opens an existing session.
    expect(args).toContain("--mini");
  });

  test("REQ-006-05 `opencode models` is its login check: a model to run, free ones included", () => {
    const check = opencode.loginCheck as Extract<LoginCheck, { args: string[] }>;
    expect(check.args).toEqual(["models"]);
    expect(check.read({ ok: true, out: "opencode/big-pickle\nopencode/beam-free\n" })).toEqual({
      ok: true,
      detail: "2 models",
    });
    expect(check.read({ ok: true, out: "" }).ok).toBe(false);
    expect(check.read({ ok: false, out: "Error: …" }).detail).toStartWith("run it with `providers login`");
  });
});

describe("OpenCode hooks (recorded payloads)", () => {
  let store: Store;
  let sessionDir: string;
  beforeEach(() => {
    store = new Store(join(dir, "state.db"));
    sessionDir = join(dir, "sessions", "1");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => store.close());
  const start = () =>
    store.createSession({ repo: "octo/app", role: "reviewer", kind: "issue", issues: [5], harness: "opencode" });
  const fire = (event: string, payload: Record<string, unknown>) =>
    handleHook({ event, payload, store, sessionId: 1, sessionDir });
  const retry = (attempt: number, message = "Rate limit reached for requests") => ({
    ...hooks.RetryStatus,
    status: { ...(hooks.RetryStatus?.status as object), attempt, message },
  });

  test("REQ-006-14 SessionStart records the session id and the model as the catalogue names it", () => {
    start();
    fire("SessionStart", hooks.SessionStart as Record<string, unknown>);
    expect(store.session(1)).toMatchObject({
      agentSessionId: "ses_e06d8aa75ffeTJsuqaLTkpifOS",
      modelId: "opencode:fake/fake-model",
    });
  });

  test("REQ-006-14 Stop blocks the turn with the Result instructions while the Result is missing, and ends it once valid", () => {
    start();
    store.patchSession(1, { coordinatorPromptPending: false });
    expect(JSON.parse(fire("Stop", hooks.Stop as Record<string, unknown>).stdout ?? "{}")).toMatchObject({
      decision: "block",
    });
    writeFileSync(
      join(sessionDir, "result.json"),
      JSON.stringify({ summary: "ok", risk: "low", riskReason: "tiny", findings: [] }),
    );
    expect(fire("Stop", hooks.Stop as Record<string, unknown>).stdout).toBeUndefined();
    expect(store.session(1)).toMatchObject({ state: "idle", needsSync: true });
  });

  test("REQ-006-14 / REQ-001-19 the block reason the plugin sends as the next prompt is not the Owner's message", () => {
    start();
    store.patchSession(1, { coordinatorPromptPending: true });
    fire("UserPromptSubmit", hooks.UserPromptSubmit as Record<string, unknown>);
    const block = JSON.parse(fire("Stop", hooks.Stop as Record<string, unknown>).stdout ?? "{}") as { reason: string };
    fire("UserPromptSubmit", { ...hooks.UserPromptSubmit, prompt: block.reason });
    expect(store.session(1)).toMatchObject({ state: "running", ownerMessagedAt: null });
    fire("UserPromptSubmit", { ...hooks.UserPromptSubmit, prompt: "Why did you stop?" });
    expect(store.session(1)?.ownerMessagedAt).not.toBeNull();
  });

  test(`REQ-006-15 / REQ-001-17 the ${OPENCODE_LIMIT_RETRIES}rd retry of a rate limit is the usage limit: the turn is aborted and the Account pauses`, () => {
    start();
    store.patchSession(1, { coordinatorPromptPending: false });
    for (let attempt = 1; attempt < OPENCODE_LIMIT_RETRIES; attempt++)
      expect(fire("session.status", retry(attempt)).stdout).toBeUndefined();
    expect(store.session(1)?.usageLimited).toBe(false);
    expect(JSON.parse(fire("session.status", retry(OPENCODE_LIMIT_RETRIES)).stdout ?? "{}")).toEqual({ abort: true });
    expect(store.session(1)).toMatchObject({ state: "idle", usageLimited: true, usageLimitResetsAt: null });
  });

  test("REQ-006-15 a retry for another reason is no usage limit", () => {
    start();
    expect(fire("session.status", retry(5, "Provider is overloaded")).stdout).toBeUndefined();
    expect(store.session(1)).toMatchObject({ state: "running", usageLimited: false });
  });
});

/** OpenCode as the plugin sees it: events and `chat.message` in, prompts and aborts out. */
describe("OpenCode plugin (generated)", () => {
  const calls: { prompts: string[]; aborts: string[] } = { prompts: [], aborts: [] };
  let hooksLog: string;
  let plugin: {
    event: (i: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>;
    "chat.message": (i: Record<string, unknown>, o: { parts: Record<string, unknown>[] }) => Promise<void>;
  };
  const SID = "ses_main";
  const settle = () => Bun.sleep(400);
  const fired = () =>
    existsSync(hooksLog)
      ? readFileSync(hooksLog, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { hook_event_name: string } & Record<string, unknown>)
      : [];
  const event = (type: string, properties: Record<string, unknown>) => plugin.event({ event: { type, properties } });
  const chat = (sessionID: string, text: string) =>
    plugin["chat.message"](
      { sessionID, agent: "build", model: { providerID: "fake", modelID: "fake-model" } },
      { parts: [{ type: "text", text }] },
    );

  beforeEach(async () => {
    calls.prompts = [];
    calls.aborts = [];
    hooksLog = join(dir, "hooks.jsonl");
    // A hook command that logs its payload and answers as `answers/<event>` says, if there is one.
    const script = join(dir, "hook.sh");
    writeFileSync(script, `cat >> '${hooksLog}'; echo >> '${hooksLog}'; cat '${dir}/answers/'"$1" 2>/dev/null; true\n`);
    mkdirSync(join(dir, "answers"));
    const file = join(dir, "issueflow.js");
    const commands = Object.fromEntries(
      ["SessionStart", "UserPromptSubmit", "Stop", "session.status"].map((ev) => [ev, `sh '${script}' '${ev}'`]),
    );
    writeFileSync(file, opencodePlugin(commands, join(dir, "hook-errors.log")));
    const mod = (await import(file)) as { CoordinatorSession: (i: unknown) => Promise<typeof plugin> };
    plugin = await mod.CoordinatorSession({
      client: {
        session: {
          promptAsync: async (o: { path: { id: string }; body: { parts: { text: string }[] } }) => {
            calls.prompts.push(`${o.path.id}: ${o.body.parts[0]?.text}`);
            return { response: { status: 204 } };
          },
          abort: async (o: { path: { id: string } }) => {
            calls.aborts.push(o.path.id);
            return { data: true };
          },
        },
      },
    });
  });

  test("REQ-006-14 a turn: SessionStart once with the model, the prompt, then Stop on idle, in that order", async () => {
    await event("session.created", { sessionID: SID, info: { id: SID } });
    await chat(SID, "Review it.");
    await event("session.status", { sessionID: SID, status: { type: "busy" } });
    await event("session.idle", { sessionID: SID });
    await chat(SID, "Again.");
    await event("session.idle", { sessionID: SID });
    await settle();
    expect(fired().map((p) => p.hook_event_name)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "UserPromptSubmit",
      "Stop",
    ]);
    expect(fired()[0]).toMatchObject({ session_id: SID, model: "fake/fake-model" });
    expect(fired()[1]).toMatchObject({ session_id: SID, prompt: "Review it." });
    expect(calls).toEqual({ prompts: [], aborts: [] });
    expect(existsSync(join(dir, "hook-errors.log"))).toBe(false);
  });

  test("REQ-006-14 / REQ-001-21 a blocked Stop sends its reason as the next prompt", async () => {
    writeFileSync(join(dir, "answers", "Stop"), JSON.stringify({ decision: "block", reason: "Write the Result." }));
    await chat(SID, "Review it.");
    await event("session.idle", { sessionID: SID });
    await settle();
    expect(calls.prompts).toEqual([`${SID}: Write the Result.`]);
  });

  test("REQ-006-15 a retry the hook script takes for the usage limit aborts the turn, and its idle gets no Stop", async () => {
    writeFileSync(join(dir, "answers", "session.status"), JSON.stringify({ abort: true }));
    await chat(SID, "Review it.");
    const status = { type: "retry", attempt: 3, message: "Rate limit reached for requests", next: 1795182126636 };
    await event("session.status", { sessionID: SID, status });
    await settle();
    expect(calls.aborts).toEqual([SID]);
    await event("session.error", { sessionID: SID, error: { name: "MessageAbortedError", data: { message: "" } } });
    await event("session.idle", { sessionID: SID });
    await settle();
    expect(fired().map((p) => p.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "session.status"]);
    expect(fired()[2]).toMatchObject({ session_id: SID, status });
    // The next prompt starts a turn that ends with Stop again.
    await chat(SID, "Go on.");
    await event("session.idle", { sessionID: SID });
    await settle();
    expect(fired().at(-1)?.hook_event_name).toBe("Stop");
  });

  test("REQ-006-14 a turn the Owner interrupts (Esc) gets no Stop, as with Claude Code", async () => {
    await chat(SID, "Review it.");
    await event("session.error", { sessionID: SID, error: { name: "MessageAbortedError", data: { message: "" } } });
    await event("session.idle", { sessionID: SID });
    await settle();
    expect(fired().map((p) => p.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit"]);
  });

  test("REQ-006-14 a subagent's session is left alone; busy statuses fire nothing", async () => {
    await event("session.created", { sessionID: "ses_child", info: { id: "ses_child", parentID: SID } });
    await chat("ses_child", "Explore the code.");
    await event("session.status", { sessionID: "ses_child", status: { type: "retry", attempt: 9, message: "429" } });
    await event("session.idle", { sessionID: "ses_child" });
    await event("session.status", { sessionID: SID, status: { type: "busy" } });
    await settle();
    expect(fired()).toEqual([]);
  });

  test("REQ-006-14 a failing hook command is logged, and the next event still runs", async () => {
    const file = join(dir, "broken.js");
    writeFileSync(
      file,
      opencodePlugin(
        { SessionStart: "exit 1", UserPromptSubmit: "echo '{not json'", Stop: "true", "session.status": "true" },
        join(dir, "hook-errors.log"),
      ),
    );
    const broken = (await import(file)) as { CoordinatorSession: (i: unknown) => Promise<typeof plugin> };
    const p = await broken.CoordinatorSession({ client: { session: {} } });
    await p["chat.message"]({ sessionID: SID }, { parts: [{ type: "text", text: "x" }] });
    await p.event({ event: { type: "session.idle", properties: { sessionID: SID } } });
    await settle();
    expect(readFileSync(join(dir, "hook-errors.log"), "utf8")).toContain("opencode plugin");
  });
});
