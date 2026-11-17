/**
 * Result files: the JSON each session must write before its turn may end (REQ-001-21).
 * Schemas per Role, as in plan.md ("Roles").
 */
import { z } from "zod";
import type { Role } from "./config.ts";
import { MOCKUP_DIR, SCREENSHOT_DIR } from "./screenshots.ts";

const issueRef = z.number().int().positive();

/** At most this many Split-off issues per Assessment entry, against runaway splitting (REQ-001-34). */
export const MAX_SPLIT_OFFS = 5;

const plannerSchema = z.array(
  z.strictObject({
    issue: issueRef,
    verdict: z.enum(["proposed", "needs-refinement", "wontfix-proposed"]),
    approach: z.string().min(1).describe("The proposed approach, or why not / what is unclear"),
    bundleWith: z.array(issueRef).describe("Issues to implement together with this one"),
    blockedBy: z.array(issueRef).describe("Issues that must be closed first"),
    questions: z.array(z.string()).describe("Questions for the Owner"),
    splitOff: z
      .array(z.strictObject({ title: z.string().trim().min(1), body: z.string().min(1) }))
      .max(MAX_SPLIT_OFFS)
      .default([])
      .describe(
        "New issues the Coordinator creates, split off from this one: independent changes, or a separate bug or follow-up found while reading the code",
      ),
    mockups: z
      .array(z.strictObject({ path: z.string().min(1), caption: z.string().min(1) }))
      .optional()
      .describe(
        `Mockups for the Owner to choose from or look at (REQ-001-60): PNG or JPEG files you saved in the ${MOCKUP_DIR}/ folder next to this Result file, outside the repository; absolute paths or relative to that folder's parent; at most 5, 2 MB each`,
      ),
    reply: z
      .string()
      .optional()
      .describe(
        "Only when the Owner's comments started this turn: a few lines on what changed in the Assessment and why, or why nothing changed",
      ),
  }),
);

const implementerSchema = z.strictObject({
  prTitle: z.string().min(1),
  prBody: z.string().min(1),
  summary: z.string().min(1).describe("What changed in this turn"),
  responses: z
    .array(
      z.strictObject({
        finding: z.number().int().positive().describe("The finding's number in the Feedback round"),
        answer: z.enum(["fixed", "declined"]),
        reason: z.string().min(1).describe("What you changed, or why the finding is wrong"),
      }),
    )
    .optional()
    .describe("Only in a Feedback round with Review findings: one answer per finding (REQ-001-35)"),
  screenshots: z
    .array(z.strictObject({ path: z.string().min(1), caption: z.string().min(1) }))
    .optional()
    .describe(
      `Screenshots of the pages your change affects (REQ-001-48): PNG or JPEG files you saved in ${SCREENSHOT_DIR}/, paths relative to the Worktree; at most 5, 2 MB each`,
    ),
});

const reviewerSchema = z.strictObject({
  summary: z.string().min(1),
  findings: z.array(
    z.strictObject({
      path: z.string().min(1),
      line: z.number().int().positive(),
      severity: z.enum(["high", "medium"]),
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

/**
 * Validates a Result file's text; `issues` are the session's issues (a Planner must assess exactly these).
 * `findings` is the number of Review findings an Implementer's Result must answer (REQ-001-35).
 */
export function validateResult(role: Role, text: string | undefined, issues: number[], findings = 0): Validation {
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
  if (role === "implementer" && findings > 0) {
    const answered = new Set(((parsed.data as ImplementerResult).responses ?? []).map((r) => r.finding));
    const missing = Array.from({ length: findings }, (_, i) => i + 1).filter((n) => !answered.has(n));
    const unknown = [...answered].filter((n) => n > findings);
    if (missing.length || unknown.length) {
      const parts = [
        missing.length ? `answer finding ${missing.join(", ")}` : "",
        unknown.length ? `remove finding ${unknown.join(", ")} (there are only ${findings})` : "",
      ].filter(Boolean);
      return {
        ok: false,
        problem: `The Result must answer each of the ${findings} Review findings in \`responses\`: ${parts.join(" and ")}.`,
      };
    }
  }
  return { ok: true, value: parsed.data };
}

/** How many Review findings the session's current Feedback round must answer (REQ-001-35). */
export function findingsToAnswer(issue: { inFeedbackRound: number; reviewFindings: string | null }): number {
  if (!issue.inFeedbackRound || !issue.reviewFindings) return 0;
  try {
    const list = JSON.parse(issue.reviewFindings);
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

/** Tells a session where to write its Result and in which shape. */
export function resultInstructions(role: Role, path: string): string {
  const schema = z.toJSONSchema(RESULT_SCHEMAS[role]);
  delete (schema as { $schema?: string }).$schema;
  return `Before ending your turn, write your Result as JSON to ${path} with your file-writing tool (Write), not a shell command; overwrite it if it exists. It must match this JSON Schema: ${JSON.stringify(schema)}`;
}
