/** The Harness registry (spec 006): which adapter runs a model, and by name. */
import { antigravity } from "./antigravity.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { HARNESS_NAMES, type Harness, type HarnessName } from "./harness.ts";

export * from "./harness.ts";

export const HARNESSES: Readonly<Record<HarnessName, Harness>> = { claude, codex, antigravity };

export const harnessByName = (name: string): Harness =>
  HARNESS_NAMES.includes(name as HarnessName) ? HARNESSES[name as HarnessName] : claude;
