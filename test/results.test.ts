import { describe, expect, test } from "bun:test";
import { resultInstructions, validateResult } from "../src/results.ts";

const planner = (issues: number[]) =>
  JSON.stringify(
    issues.map((issue) => ({
      issue,
      verdict: "proposed",
      approach: "Do it",
      bundleWith: [],
      blockedBy: [],
      questions: [],
    })),
  );

describe("Result validation", () => {
  test("REQ-001-21 accepts a valid Result for each Role", () => {
    expect(validateResult("planner", planner([5, 6]), [5, 6]).ok).toBe(true);
    expect(validateResult("implementer", JSON.stringify({ prTitle: "T", prBody: "B", summary: "S" }), [5]).ok).toBe(
      true,
    );
    const review = {
      summary: "S",
      findings: [{ path: "a.ts", line: 3, severity: "high", body: "Bug" }],
    };
    expect(validateResult("reviewer", JSON.stringify(review), [9]).ok).toBe(true);
  });

  test("REQ-001-21 explains a missing file, invalid JSON and schema mismatches", () => {
    expect(validateResult("implementer", undefined, [5])).toEqual({
      ok: false,
      problem: "The Result file is missing.",
    });
    expect(validateResult("implementer", "{", [5])).toEqual({
      ok: false,
      problem: "The Result file is not valid JSON.",
    });
    const r = validateResult("implementer", JSON.stringify({ prTitle: "T" }), [5]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problem).toContain("prBody");
  });

  test("REQ-001-21 a Planner Result must assess exactly the session's issues", () => {
    const missing = validateResult("planner", planner([5]), [5, 6]);
    expect(!missing.ok && missing.problem).toContain("#6");
    const extra = validateResult("planner", planner([5, 7]), [5]);
    expect(!extra.ok && extra.problem).toContain("#7");
  });

  test("REQ-001-21 instructions name the file and show the expected shape", () => {
    const text = resultInstructions("reviewer", "/state/sessions/3/result.json");
    expect(text).toContain("/state/sessions/3/result.json");
    expect(text).toContain("findings");
    expect(text).not.toContain("blocking");
  });

  test("REQ-002-08 a Reviewer finding has severity high or medium and no blocking field", () => {
    const review = (f: Record<string, unknown>) =>
      JSON.stringify({ summary: "S", findings: [{ path: "a.ts", line: 3, severity: "medium", body: "Bug", ...f }] });
    expect(validateResult("reviewer", review({}), [9]).ok).toBe(true);
    expect(validateResult("reviewer", review({ severity: "low" }), [9]).ok).toBe(false);
    expect(validateResult("reviewer", review({ blocking: true }), [9]).ok).toBe(false);
  });

  test("REQ-001-34 in a Feedback round with Review findings, the Implementer must answer each one", () => {
    const impl = (responses?: unknown[]) =>
      JSON.stringify({ prTitle: "T", prBody: "B", summary: "S", ...(responses ? { responses } : {}) });
    const fixed = (finding: number) => ({ finding, answer: "fixed", reason: "Added a guard" });
    expect(validateResult("implementer", impl(), [5]).ok).toBe(true);
    expect(
      validateResult("implementer", impl([fixed(1), { finding: 2, answer: "declined", reason: "Wrong" }]), [5], 2).ok,
    ).toBe(true);
    const missing = validateResult("implementer", impl([fixed(1)]), [5], 2);
    expect(!missing.ok && missing.problem).toContain("2");
    expect(!missing.ok && missing.problem).toContain("responses");
    expect(validateResult("implementer", impl(), [5], 1).ok).toBe(false);
    expect(validateResult("implementer", impl([fixed(1), fixed(3)]), [5], 1).ok).toBe(false);
    expect(validateResult("implementer", impl([{ finding: 1, answer: "maybe", reason: "x" }]), [5], 1).ok).toBe(false);
    expect(validateResult("implementer", impl([{ finding: 1, answer: "declined", reason: "" }]), [5], 1).ok).toBe(
      false,
    );
  });
});
