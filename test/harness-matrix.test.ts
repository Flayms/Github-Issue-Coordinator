import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { featureMatrix, MATRIX_END, MATRIX_START } from "../src/harness/matrix.ts";

const doc = readFileSync(join(import.meta.dir, "..", "docs", "harnesses.md"), "utf8");
const agents = readFileSync(join(import.meta.dir, "..", "AGENTS.md"), "utf8");

/** Table rows by their cells, so the formatter's column padding doesn't count. */
const cells = (md: string): string[] =>
  md
    .trim()
    .split("\n")
    .map((line) =>
      line.startsWith("|")
        ? line
            .split("|")
            .map((c) => c.trim().replace(/^-+$/, "---"))
            .join("|")
        : line,
    );

describe("Harness feature matrix (docs/harnesses.md)", () => {
  test("REQ-006-06 the table matches the features each Harness adapter declares", () => {
    const inDoc = doc.split(MATRIX_START)[1]?.split(MATRIX_END)[0] ?? "";
    // To update: bun -e 'import { featureMatrix } from "./src/harness/matrix.ts"; console.log(featureMatrix())'
    expect(cells(inDoc)).toEqual(cells(featureMatrix()));
  });

  test("REQ-006-06 a missing feature says what the Owner loses", () => {
    const matrix = featureMatrix();
    expect(matrix).toContain("| Feature | Claude Code | Codex CLI |");
    expect(matrix).toMatch(/^- \*\*Codex CLI, Remote Control \/ Open chat:\*\* .+$/m);
  });

  test("REQ-006-06 AGENTS.md lists the doc in its Orientation table", () => {
    expect(agents).toMatch(/^\| `docs\/harnesses\.md` +\|/m);
  });
});
