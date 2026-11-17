/**
 * Builds the dashboard's stylesheet from its Tailwind source (`styles.css`) when the Coordinator
 * starts, so the Owner has no build step of their own (REQ-003-19). Tailwind scans the components
 * for the classes they use and emits only those.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const SOURCE = join(import.meta.dir, "styles.css");

export async function buildStyles(): Promise<string> {
  const compiler = await compile(readFileSync(SOURCE, "utf8"), { base: import.meta.dir, onDependency: () => {} });
  const candidates = new Scanner({ sources: compiler.sources }).scan();
  return optimize(compiler.build(candidates), { file: SOURCE }).code;
}
