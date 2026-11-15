import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LABELS } from "../src/labels.ts";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const labelsSection = readme.split(/^## Labels$/m)[1]?.split(/^## /m)[0] ?? "";

describe("README Labels section", () => {
  test("has a state diagram", () => {
    expect(labelsSection).toContain("```mermaid\nstateDiagram-v2");
  });

  for (const { name } of AGENT_LABELS)
    test(`documents ${name} in the diagram and the table`, () => {
      expect(labelsSection).toContain(`state "${name}" as `);
      expect(labelsSection).toMatch(new RegExp(`^\\| \`${name}\` +\\|`, "m"));
    });
});
