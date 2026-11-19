import { describe, expect, test } from "bun:test";
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
