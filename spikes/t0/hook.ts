#!/usr/bin/env bun
/**
 * Claude Code hook used by the T0 spike. Usage: bun hook.ts <event> <stateDir>
 * Appends every event to <stateDir>/events.jsonl. On `Stop` it validates the Result file
 * against <stateDir>/expected.json and blocks the stop (with a reason) while it is invalid.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BLOCKS = 3;
const [event = "unknown", stateDir = "."] = Bun.argv.slice(2);

const raw = await Bun.stdin.text();
let payload: Record<string, unknown>;
try {
  payload = JSON.parse(raw);
} catch {
  payload = { raw };
}

const log = (extra: Record<string, unknown> = {}) =>
  appendFileSync(
    join(stateDir, "events.jsonl"),
    `${JSON.stringify({ t: new Date().toISOString(), event, ...extra, payload })}\n`,
  );

if (event !== "Stop") {
  log();
  process.exit(0);
}

const resultPath = join(stateDir, "result.json");
const expectedPath = join(stateDir, "expected.json");
const blocksPath = join(stateDir, "stop-blocks");
const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : null;

let problem: string | null = null;
if (!existsSync(resultPath)) {
  problem = `The Result file ${resultPath} is missing.`;
} else {
  try {
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    if (expected && result.word !== expected.word) {
      problem = `The Result file has word ${JSON.stringify(result.word)}, expected ${JSON.stringify(expected.word)}.`;
    }
  } catch {
    problem = `The Result file ${resultPath} is not valid JSON.`;
  }
}

const blocks = existsSync(blocksPath) ? Number(readFileSync(blocksPath, "utf8")) : 0;
if (problem && blocks < MAX_BLOCKS) {
  writeFileSync(blocksPath, String(blocks + 1));
  log({ blocked: true, problem });
  const reason = `${problem} Before ending your turn, write the file ${resultPath} containing at least these fields: ${JSON.stringify(expected)}`;
  console.log(JSON.stringify({ decision: "block", reason }));
} else {
  log({ blocked: false, problem, gaveUp: problem !== null });
}
process.exit(0);
