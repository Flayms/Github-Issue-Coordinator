/**
 * Result files: the JSON each session must write before its turn may end (REQ-001-21).
 * Schemas per Role, as in plan.md ("Roles").
 */
import { z } from "zod";
import type { Role } from "./config.ts";

const issueRef = z.number().int().positive();

const plannerSchema = z.array(
  z.strictObject({
    issue: issueRef,
    verdict: z.enum(["proposed", "needs-refinement", "wontfix-proposed"]),
    approach: z.string().min(1).describe("The proposed approach, or why not / what is unclear"),
    bundleWith: z.array(issueRef).describe("Issues to implement together with this one"),
    blockedBy: z.array(issueRef).describe("Issues that must be closed first"),
    questions: z.array(z.string()).describe("Questions for the Owner"),
  }),
);

const implementerSchema = z.strictObject({
  prTitle: z.string().min(1),
  prBody: z.string().min(1),
  summary: z.string().min(1).describe("What changed in this turn"),
});

const reviewerSchema = z.strictObject({
  summary: z.string().min(1),
  findings: z.array(
    z.strictObject({
      path: z.string().min(1),
      line: z.number().int().positive(),
      severity: z.enum(["high", "medium", "low"]),
      blocking: z.boolean().describe("true if the PR must not be merged without fixing this"),
      body: z.string().min(1),
    }),
  ),
});

export const RESULT_SCHEMAS = {
  planner: plannerSchema,
  implementer: implementerSchema,
  reviewer: reviewerSchema,
} as const;

export type PlannerResult = z.output<typeof plannerSchema>;
export type ImplementerResult = z.output<typeof implementerSchema>;
export type ReviewerResult = z.output<typeof reviewerSchema>;

export type Validation = { ok: true; value: unknown } | { ok: false; problem: string };

/** Validates a Result file's text; `issues` are the session's issues (a Planner must assess exactly these). */
export function validateResult(role: Role, text: string | undefined, issues: number[]): Validation {
  if (text === undefined) return { ok: false, problem: "The Result file is missing." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: "The Result file is not valid JSON." };
  }
  const parsed = RESULT_SCHEMAS[role].safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, problem: `The Result file does not match the schema: ${details}.` };
  }
  if (role === "planner") {
    const assessed = new Set((parsed.data as PlannerResult).map((a) => a.issue));
    const missing = issues.filter((n) => !assessed.has(n));
    const extra = [...assessed].filter((n) => !issues.includes(n));
    if (missing.length || extra.length) {
      const parts = [
        missing.length ? `assess ${missing.map((n) => `#${n}`).join(", ")}` : "",
        extra.length ? `remove ${extra.map((n) => `#${n}`).join(", ")} (not part of this session)` : "",
      ].filter(Boolean);
      return {
        ok: false,
        problem: `The Result file must contain one entry per issue of this session: ${parts.join(" and ")}.`,
      };
    }
  }
  return { ok: true, value: parsed.data };
}

/** Tells a session where to write its Result and in which shape. */
export function resultInstructions(role: Role, path: string): string {
  const schema = z.toJSONSchema(RESULT_SCHEMAS[role]);
  delete (schema as { $schema?: string }).$schema;
  return `Before ending your turn, write your Result as JSON to ${path} with your file-writing tool (Write), not a shell command; overwrite it if it exists. It must match this JSON Schema: ${JSON.stringify(schema)}`;
}
