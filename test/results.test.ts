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
      findings: [{ path: "a.ts", line: 3, severity: "high", blocking: true, body: "Bug" }],
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

  test("REQ-001-34 a Planner entry may list up to 5 Split-off issues, each with a title and body", () => {
    const withSplitOffs = (n: number, title = "T") =>
      JSON.stringify([
        {
          issue: 5,
          verdict: "proposed",
          approach: "Do it",
          bundleWith: [],
          blockedBy: [],
          questions: [],
          splitOff: Array.from({ length: n }, () => ({ title, body: "B" })),
        },
      ]);
    expect(validateResult("planner", withSplitOffs(5), [5]).ok).toBe(true);
    const tooMany = validateResult("planner", withSplitOffs(6), [5]);
    expect(!tooMany.ok && tooMany.problem).toContain("splitOff");
    expect(validateResult("planner", withSplitOffs(1, ""), [5]).ok).toBe(false);
    const parsed = validateResult("planner", planner([5]), [5]); // older Results without the field stay valid
    expect(parsed.ok && (parsed.value as { splitOff: unknown[] }[])[0]?.splitOff).toEqual([]);
    expect(resultInstructions("planner", "/r.json")).toContain("splitOff");
  });

  test("REQ-001-35 a Planner entry may carry a reply to the Owner's comments", () => {
    const withReply = (reply: unknown) =>
      JSON.stringify([
        { issue: 5, verdict: "proposed", approach: "Do it", bundleWith: [], blockedBy: [], questions: [], reply },
      ]);
    const parsed = validateResult("planner", withReply("Switched to v2."), [5]);
    expect(parsed.ok && (parsed.value as { reply?: string }[])[0]?.reply).toBe("Switched to v2.");
    expect(validateResult("planner", withReply(3), [5]).ok).toBe(false);
    expect(validateResult("planner", planner([5]), [5]).ok).toBe(true); // optional
    expect(resultInstructions("planner", "/r.json")).toContain("reply");
  });

  test("REQ-001-21 instructions name the file and show the expected shape", () => {
    const text = resultInstructions("reviewer", "/state/sessions/3/result.json");
    expect(text).toContain("/state/sessions/3/result.json");
    expect(text).toContain("findings");
    expect(text).toContain("blocking");
  });
});
