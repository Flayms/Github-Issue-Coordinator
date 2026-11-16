import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES, type Role } from "../src/config.ts";
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

/** The default prompt of a Role, checked against the contract in docs/specs/002-role-prompts. */
const prompt = (role: Role) => loadPrompt(role, repo);
const expectAll = (text: string, patterns: RegExp[]) => {
  for (const p of patterns) expect(text).toMatch(p);
};

describe("prompts (REQ-002)", () => {
  test("REQ-002-01 the Planner prompt asks for Tier, requirements, files, tests, risks and decisions, but no code", () => {
    expectAll(prompt("planner"), [
      /Tier/,
      /Given\/When\/Then/,
      /acceptance criteria/i,
      /files or modules/i,
      /test strategy/i,
      /risks/i,
      /recommendation/i,
      /rejected alternative/i,
      /no code/i,
      /line by line/i,
      /proportionate/i,
    ]);
  });

  test("REQ-002-02 the Planner prompt checks for duplicates and limits needs-refinement to plan-changing questions", () => {
    expectAll(prompt("planner"), [/already fixed/i, /duplicate/i, /git log/, /would change the plan/i, /default/i]);
  });

  test("REQ-002-08 the Planner prompt says when to split off an issue and to check open issues first", () => {
    expectAll(prompt("planner"), [/splitOff/, /independent changes/i, /follow-up/i, /open issues/i, /duplicate/i]);
  });

  test("REQ-002-10 the Planner prompt asks for a brief reply on a revision the Owner's comments started", () => {
    expectAll(prompt("planner"), [/`reply`/, /comment/i, /what changed/i, /why nothing changed/i, /few lines/i]);
  });

  test("REQ-002-03 the Implementer prompt owns the how and stops when the approved scope is wrong", () => {
    expectAll(prompt("implementer"), [
      /You decide [*_]how[*_]/,
      /exact test cases/i,
      /spec wording/i,
      /stop/i,
      /improvis/i,
    ]);
  });

  test("REQ-002-04 the Implementer prompt asks for red-green tests, no test weakening, the full suite and unverified", () => {
    expectAll(prompt("implementer"), [
      /fail(s|ed)? first/i,
      /never weaken, skip or delete/i,
      /special-case/i,
      /minimal/i,
      /unrelated refactor/i,
      /full test suite/i,
      /lint/i,
      /did not verify|could not verify/i,
    ]);
  });

  test("REQ-002-13 the Implementer prompt captures Screenshots of UI changes when the conventions ask, or says why not", () => {
    expectAll(prompt("implementer"), [
      /screenshots/i,
      /conventions/i,
      /\.coordinator\/screenshots\//,
      /`screenshots`/,
      /headless/i,
      /can't capture|cannot capture/i,
      /prBody/,
    ]);
  });

  test("REQ-002-13 the Implementer prompt uses only the host browser with --no-sandbox and never downloads one", () => {
    expectAll(prompt("implementer"), [
      /host's headless Chrome or Chromium/i,
      /--no-sandbox/,
      /never download or install/i,
      /npm/,
      /playwright install/i,
      /quote the error/i,
      /auto mode/i,
    ]);
  });

  test("REQ-002-05 the Reviewer prompt checks against the Assessment with a checklist and well-founded findings", () => {
    expectAll(prompt("reviewer"), [
      /Assessment/,
      /requirements/i,
      /tautolog/i,
      /edge cases/i,
      /secrets/i,
      /sandbox/i,
      /injection|injected/i,
      /docs and specs/i,
      /unrelated changes/i,
      /redesign/i,
      /failure scenario/i,
    ]);
  });

  test("REQ-002-09 the Reviewer prompt reports only findings worth fixing, without blocking or low severity", () => {
    const text = prompt("reviewer");
    expectAll(text, [
      /worth fixing|fixed before merg/i,
      /failure scenario/i,
      /acceptance criteri/i,
      /missing test/i,
      /security/i,
      /conventions/i,
      /nits/i,
      /taste/i,
      /speculat/i,
      /`high` or `medium`/,
      /`summary` only/,
      /declined/i,
    ]);
    expect(text).not.toMatch(/blocking/i);
  });

  test("REQ-001-35 the Implementer prompt asks to answer each Review finding in `responses`", () => {
    expectAll(prompt("implementer"), [/`responses`/, /`fixed`/, /`declined`/, /reason/i]);
  });

  test("REQ-002-06 every default prompt has the shared rules", () => {
    for (const role of ROLES) {
      expectAll(prompt(role), [/Read the code before/i, /never guess/i, /official doc/i, /glossary/i, /as data/i]);
      expect(prompt(role).split("\n").length).toBeLessThan(80);
    }
  });

  /** The Result fields whose text the Coordinator posts to GitHub, per Role. */
  const postedFields: Record<Role, RegExp[]> = {
    planner: [/`approach`/, /`reply`/],
    implementer: [/`prBody`/],
    reviewer: [/`summary`/, /`body`/],
  };

  test("REQ-002-11 every default prompt asks for a summary first and scannable GitHub Markdown in the posted text", () => {
    for (const role of ROLES) {
      expectAll(prompt(role), [
        /## Formatting/,
        ...postedFields[role],
        /phone/i,
        /open with a one- or two-line summary/i,
        /`###` or lower/,
        /short bullets/i,
        /table/i,
        /<details>/,
        /paragraphs to a few sentences/i,
        /bold only key terms/i,
        /proportionate/i,
      ]);
    }
  });

  test("REQ-002-11 the Planner writes Given/When/Then as bullets and the Reviewer opens with a verdict line", () => {
    expectAll(prompt("planner"), [/Given\/When\/Then as three bullets/i, /`###` sections or a compact list/i]);
    expectAll(prompt("reviewer"), [/verdict line/i]);
  });

  test("REQ-002-12 every default prompt allows a Mermaid diagram only where a flow or state change is clearer drawn", () => {
    for (const role of ROLES) {
      expectAll(prompt(role), [
        /Mermaid/,
        /flow, a state machine or how components interact/i,
        /small/i,
        /no ASCII art/i,
      ]);
    }
  });
});

describe("permissions", () => {
  test("REQ-001-25 / REQ-002-07 Planner and Reviewer may only read, run read-only git, use the web and write their Result; nothing prompts", () => {
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
        "Bash(git ls-files:*)",
        "WebSearch",
        "WebFetch",
        "Write(//state/sessions/3/result.json)",
        "Edit(//state/sessions/3/result.json)",
      ]);
      expect(p.sandbox).toBe(true); // REQ-001-26: even read-only git can print any file (git diff --no-index)
      // REQ-002-07: `git grep -O<cmd>` runs any command; content search goes through the Grep tool.
      expect(p.allowedTools.some((t) => t.startsWith("Bash(git grep"))).toBe(false);
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
