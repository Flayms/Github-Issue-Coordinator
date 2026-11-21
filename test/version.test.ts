import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newerVersion, VERSION, versionCheck } from "../src/version.ts";

describe("version", () => {
  test("REQ-007-12 the version is package.json's", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("REQ-007-12 a newer version on npm is told apart from the same or an older one", () => {
    expect(newerVersion("0.1.0", "0.2.0")).toBe(true);
    expect(newerVersion("0.1.9", "0.1.10")).toBe(true);
    expect(newerVersion("1.0.0", "0.9.9")).toBe(false);
    expect(newerVersion("0.2.0", "0.2.0")).toBe(false);
    expect(newerVersion("0.2.0", "garbage")).toBe(false);
  });
});

describe("doctor's version check", () => {
  const npm = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("REQ-007-12 names the version, and a newer one on npm with the command to update", async () => {
    expect(await versionCheck("0.1.0", npm({ version: "0.1.0" }))).toEqual({
      status: "ok",
      check: "version",
      detail: "0.1.0 (the latest on npm)",
    });
    expect(await versionCheck("0.1.0", npm({ version: "0.3.0" }))).toEqual({
      status: "warn",
      check: "version",
      detail: "0.1.0; 0.3.0 is on npm: bun add -g issueflow@latest && issueflow service restart",
    });
  });

  test("REQ-007-12 npm out of reach is a warning, never a problem", async () => {
    const down = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await versionCheck("0.1.0", down)).toEqual({
      status: "warn",
      check: "version",
      detail: "0.1.0; could not ask npm for a newer one (getaddrinfo ENOTFOUND)",
    });
    expect((await versionCheck("0.1.0", npm({}, 404))).status).toBe("warn");
  });
});
