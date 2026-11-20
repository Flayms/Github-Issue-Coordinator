import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configJsonSchema } from "../src/config.ts";
import { CONFIG_SCHEMA_PATH } from "../src/version.ts";

describe("config.schema.json", () => {
  test("REQ-007-04 the shipped schema is the one generated from the config rules (`bun run schema` updates it)", () => {
    expect(CONFIG_SCHEMA_PATH).toBe(join(import.meta.dir, "..", "config.schema.json"));
    const shipped = JSON.parse(readFileSync(CONFIG_SCHEMA_PATH, "utf8"));
    expect(shipped).toEqual(JSON.parse(JSON.stringify(configJsonSchema())));
  });

  test("REQ-007-04 it names every top-level key, allows $schema and refuses unknown keys", () => {
    const s = configJsonSchema() as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
      required: string[];
    };
    expect(Object.keys(s.properties)).toEqual(
      expect.arrayContaining(["$schema", "owner", "repos", "roles", "accounts", "dashboard", "limits", "stateDir"]),
    );
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["owner", "roles", "repos"]);
  });
});
