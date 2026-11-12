import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES } from "../src/config.ts";
import { loadPrompt, renderPrompt, rolePermissions } from "../src/prompts.ts";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "prompts-"));
});
afterEach(() => rmSync(repo, { recursive: true }));

describe("prompts", () => {
  test("REQ-001-22 each Role has a default prompt", () => {
    for (const role of ROLES) expect(loadPrompt(role, repo).length).toBeGreaterThan(200);
  });

  test("REQ-001-22 a repository can replace a Role's prompt with .github/coordinator/<role>.md", () => {
    mkdirSync(join(repo, ".github/coordinator"), { recursive: true });
    writeFileSync(join(repo, ".github/coordinator/reviewer.md"), "Custom reviewer for {{repo}}");
    expect(loadPrompt("reviewer", repo)).toBe("Custom reviewer for {{repo}}");
    expect(loadPrompt("planner", repo)).not.toContain("Custom");
  });

  test("renders placeholders and refuses unknown ones", () => {
    expect(renderPrompt("Work on {{repo}}#{{issue}}.", { repo: "octo/app", issue: "5" })).toBe("Work on octo/app#5.");
    expect(() => renderPrompt("Hi {{nobody}}", { repo: "x" })).toThrow("{{nobody}}");
  });

  test("default prompts only use placeholders the Coordinator fills in", () => {
    const vars = { repo: "r", context: "c" };
    for (const role of ROLES) expect(() => renderPrompt(loadPrompt(role, repo), vars)).not.toThrow();
  });
});

describe("permissions", () => {
  test("REQ-001-25 Planner and Reviewer may only read, run read-only git, use the web and write their Result; nothing prompts", () => {
    for (const role of ["planner", "reviewer"] as const) {
      const p = rolePermissions(role, "/state/sessions/3");
      expect(p.permissionMode).toBe("dontAsk");
      expect(p.allowedTools).toEqual([
        "Read",
        "Grep",
        "Glob",
        "Bash(git log:*)",
        "Bash(git show:*)",
        "Bash(git diff:*)",
        "Bash(git status:*)",
        "WebSearch",
        "WebFetch",
        "Write(//state/sessions/3/result.json)",
        "Edit(//state/sessions/3/result.json)",
      ]);
      expect(p.sandbox).toBe(true); // REQ-001-26: even read-only git can print any file (git diff --no-index)
    }
  });

  test("REQ-001-25 the Implementer runs in auto mode inside the sandbox", () => {
    expect(rolePermissions("implementer", "/s")).toEqual({
      permissionMode: "auto",
      allowedTools: [],
      sandbox: true,
    });
  });
});
