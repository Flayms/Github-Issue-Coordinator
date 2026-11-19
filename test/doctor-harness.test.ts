import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessChecks, type Run } from "../src/harness/checks.ts";

/** A fake command runner: answers by the command line and the Account's folder variable. */
const fakeRun =
  (answers: Record<string, { ok: boolean; out: string }>): Run =>
  (cmd, env) => {
    const folder = env?.CODEX_HOME ?? env?.CLAUDE_CONFIG_DIR ?? "";
    return answers[`${folder} ${cmd.join(" ")}`.trim()] ?? answers[cmd.join(" ")] ?? { ok: false, out: "" };
  };

describe("setup check per Harness (spec 006)", () => {
  test("REQ-006-05 checks the CLI, its version and the login of each Harness that has an Account", () => {
    const run = fakeRun({
      "claude --version": { ok: true, out: "2.1.328 (Claude Code)" },
      "claude auth status": { ok: true, out: '{"loggedIn":true,"subscriptionType":"max"}' },
      "codex --version": { ok: true, out: "codex-cli 0.170.0" },
      "/home/a/.codex-gpt codex login status": { ok: true, out: "Logged in using ChatGPT" },
    });
    const checks = harnessChecks(
      [{ name: "main" }, { name: "gpt", harness: "codex", configDir: "/home/a/.codex-gpt" }],
      run,
      {},
    );
    expect(checks).toEqual([
      { status: "ok", check: "claude installed", detail: "2.1.328 (Claude Code)" },
      { status: "ok", check: "claude logged in (Account main)", detail: "max subscription" },
      { status: "ok", check: "codex installed", detail: "codex-cli 0.170.0" },
      { status: "ok", check: "codex logged in (Account gpt)", detail: "Logged in using ChatGPT" },
    ]);
  });

  test("REQ-006-05 a Harness without an Account is not checked; a missing login or an old CLI is reported", () => {
    expect(harnessChecks([{ name: "default" }], fakeRun({}), {}).map((c) => c.check)).toEqual([
      "claude installed",
      "claude logged in",
    ]);
    const checks = harnessChecks(
      [{ name: "gpt", harness: "codex" }],
      fakeRun({
        "codex --version": { ok: true, out: "codex-cli 0.99.0" },
        "codex login status": { ok: false, out: "Not logged in" },
      }),
      {},
    );
    expect(checks).toEqual([
      { status: "warn", check: "codex installed", detail: "codex-cli 0.99.0; checked with 0.170.0 or newer" },
      { status: "fail", check: "codex logged in", detail: "run `codex` with the `login` subcommand" },
    ]);
  });
});

describe("setup check for Copilot CLI (spec 006, #176)", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-copilot-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("REQ-006-10 checks the CLI version and reads each Account's login from its folder, without a login command", () => {
    const work = join(dir, ".copilot-work");
    mkdirSync(work);
    writeFileSync(
      join(work, "config.json"),
      readFileSync(join(import.meta.dir, "fixtures", "copilot", "config.jsonc")),
    );
    const run = fakeRun({
      "copilot --version": { ok: true, out: "GitHub Copilot CLI 1.0.114.\nRun 'copilot update'" },
    });
    const checks = harnessChecks(
      [
        { name: "work", harness: "copilot", configDir: work },
        { name: "personal", harness: "copilot", configDir: join(dir, ".copilot-none") },
      ],
      run,
      { HOME: dir },
    );
    expect(checks).toEqual([
      { status: "ok", check: "copilot installed", detail: "GitHub Copilot CLI 1.0.114." },
      { status: "ok", check: "copilot logged in (Account work)", detail: "octocat" },
      {
        status: "fail",
        check: "copilot logged in (Account personal)",
        detail: expect.stringMatching(/^run `COPILOT_HOME=\S+\.copilot-none copilot` with the `login` subcommand/),
      },
    ]);
  });

  test("REQ-006-10 an old CLI is reported; an Account without its own folder uses ~/.copilot", () => {
    mkdirSync(join(dir, ".copilot"), { recursive: true });
    writeFileSync(
      join(dir, ".copilot", "config.json"),
      readFileSync(join(import.meta.dir, "fixtures", "copilot", "config.jsonc")),
    );
    const run = fakeRun({ "copilot --version": { ok: true, out: "GitHub Copilot CLI 0.0.400." } });
    expect(harnessChecks([{ name: "c", harness: "copilot" }], run, { HOME: dir })).toEqual([
      {
        status: "warn",
        check: "copilot installed",
        detail: "GitHub Copilot CLI 0.0.400.; checked with 1.0.114 or newer",
      },
      { status: "ok", check: "copilot logged in", detail: "octocat" },
    ]);
  });
});
