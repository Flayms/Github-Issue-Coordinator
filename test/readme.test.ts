import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LABELS, PR_PHASE_LABELS } from "../src/labels.ts";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const labelsSection = readme.split(/^## Labels$/m)[1]?.split(/^## /m)[0] ?? "";

describe("README Labels section", () => {
  test("has a state diagram", () => {
    expect(labelsSection).toContain("```mermaid\nstateDiagram-v2");
  });

  test("REQ-001-52 says that an agent PR carries its issues' PR-phase label, in the text and the diagram", () => {
    const sentence = labelsSection.match(/^Each issue's state .*$/m)?.[0] ?? "";
    expect(sentence).toContain("the PR carries the same label as its issues");
    for (const l of PR_PHASE_LABELS) expect(sentence).toContain(`\`${l}\``);
    expect(labelsSection).toMatch(/^ *note .*the agent PR carries the same label as its issues$/m);
  });

  for (const { name } of AGENT_LABELS)
    test(`documents ${name} in the diagram and the table`, () => {
      expect(labelsSection).toContain(`state "${name}" as `);
      expect(labelsSection).toMatch(new RegExp(`^\\| \`${name}\` +\\|`, "m"));
    });

  for (const { name, color } of AGENT_LABELS)
    test(`colours ${name} as on GitHub (#${color})`, () => {
      const id = labelsSection.match(new RegExp(`state "${name}" as (\\w+)`))?.[1];
      const cls = labelsSection.match(new RegExp(`^ *class ${id} (\\w+)$`, "m"))?.[1];
      expect(labelsSection).toMatch(new RegExp(`^ *classDef ${cls} fill:#${color}[,\\s]`, "m"));
    });
});
