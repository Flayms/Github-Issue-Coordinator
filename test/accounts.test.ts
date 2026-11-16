import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Account, accountDir, allPausedUntil, copyTranscript, freeAccount } from "../src/accounts.ts";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const A: Account = { name: "a", configDir: "/home/agent/.claude-a" };
const B: Account = { name: "b", configDir: "/home/agent/.claude-b" };
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const pauses =
  (p: Record<string, string>) =>
  (name: string): string | undefined =>
    p[name];

describe("Accounts", () => {
  test("REQ-004-01 the first Account in config order that isn't paused is used", () => {
    expect(freeAccount([A, B], pauses({}), NOW)).toEqual(A);
    expect(freeAccount([A, B], pauses({ a: at(10) }), NOW)).toEqual(B);
    // A pause that has run out no longer counts.
    expect(freeAccount([A, B], pauses({ a: at(-1) }), NOW)).toEqual(A);
    expect(freeAccount([A, B], pauses({ a: at(10), b: at(5) }), NOW)).toBeUndefined();
  });

  test("REQ-001-17 new work waits only while every Account is paused, until the first one is free again", () => {
    expect(allPausedUntil([A, B], pauses({ a: at(10) }), NOW)).toBeUndefined();
    expect(allPausedUntil([A, B], pauses({ a: at(10), b: at(5) }), NOW)).toBe(at(5));
    expect(allPausedUntil([A, B], pauses({ a: at(10), b: at(-5) }), NOW)).toBeUndefined();
    expect(allPausedUntil([{ name: "default" }], pauses({ default: at(30) }), NOW)).toBe(at(30));
  });

  test("REQ-004-01 an Account without configDir is Claude's default folder", () => {
    expect(accountDir({ name: "default" }, "/home/agent")).toBe("/home/agent/.claude");
    expect(accountDir(A, "/home/agent")).toBe("/home/agent/.claude-a");
  });
});

describe("copyTranscript", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "accounts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test("REQ-001-17 copies a session's transcript to another Account so it can be resumed there", () => {
    const from = join(dir, "a");
    const to = join(dir, "b");
    const project = join(from, "projects", "-work-app-5");
    mkdirSync(join(project, "c1", "subagents"), { recursive: true });
    writeFileSync(join(project, "c1.jsonl"), "turns of c1\n");
    writeFileSync(join(project, "c1", "subagents", "x.jsonl"), "subagent\n");
    writeFileSync(join(project, "c2.jsonl"), "another session\n");
    mkdirSync(join(to, "projects", "-work-app-5"), { recursive: true });
    writeFileSync(join(to, "projects", "-work-app-5", "c1.jsonl"), "stale copy\n");

    expect(copyTranscript("c1", from, to)).toBe(true);
    expect(readFileSync(join(to, "projects", "-work-app-5", "c1.jsonl"), "utf8")).toBe("turns of c1\n");
    expect(readFileSync(join(to, "projects", "-work-app-5", "c1", "subagents", "x.jsonl"), "utf8")).toBe("subagent\n");
    expect(existsSync(join(to, "projects", "-work-app-5", "c2.jsonl"))).toBe(false);
  });

  test("REQ-001-17 copies nothing when the transcript isn't there", () => {
    expect(copyTranscript("c1", join(dir, "a"), join(dir, "b"))).toBe(false);
    expect(existsSync(join(dir, "b"))).toBe(false);
  });
});
