/**
 * REQ-006-06: the Harness feature matrix of docs/harnesses.md, built from what each adapter declares, so the doc can't
 * drift from the code: `bun test` compares the two.
 */
import { CORE_FEATURES, type Feature, HARNESS_NAMES, HARNESSES, OPTIONAL_FEATURES } from "./index.ts";

export const MATRIX_START = "<!-- feature-matrix:start (generated from src/harness; bun test checks it) -->";
export const MATRIX_END = "<!-- feature-matrix:end -->";

const FEATURES = { ...CORE_FEATURES, ...OPTIONAL_FEATURES } as Record<Feature, string>;

/** The table, one row per feature and a column per Harness, then a note per missing feature. */
export function featureMatrix(): string {
  const harnesses = HARNESS_NAMES.map((n) => HARNESSES[n]);
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const lines = [
    row(["Feature", ...harnesses.map((h) => h.label)]),
    row(["---", ...harnesses.map(() => "---")]),
    ...(Object.keys(FEATURES) as Feature[]).map((f) =>
      row([
        `${FEATURES[f]}${f in CORE_FEATURES ? " (core)" : ""}`,
        ...harnesses.map((h) => {
          const s = h.features[f];
          return s.has ? `✅${s.how ? ` ${s.how}` : ""}` : "❌";
        }),
      ]),
    ),
    row(["Minimum CLI version", ...harnesses.map((h) => `\`${h.bin}\` ${h.minVersion}`)]),
    "",
    ...harnesses.flatMap((h) =>
      (Object.keys(FEATURES) as Feature[]).flatMap((f) => {
        const s = h.features[f];
        return s.has ? [] : [`- **${h.label}, ${FEATURES[f]}:** ${s.why}.`];
      }),
    ),
  ];
  return lines.join("\n");
}
