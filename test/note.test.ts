import { describe, expect, test } from "bun:test";
import { agentNote, modelDisplayName } from "../src/note.ts";

describe("agent note", () => {
  test("REQ-001-29 names the model family and version from its id", () => {
    expect(modelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelDisplayName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelDisplayName("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelDisplayName("claude-opus-4-20250514")).toBe("Opus 4");
    expect(modelDisplayName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelDisplayName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
  });

  test("REQ-001-29 an alias or unknown id has no version", () => {
    expect(modelDisplayName("opus")).toBeUndefined();
    expect(modelDisplayName("gpt-4")).toBeUndefined();
    expect(modelDisplayName(undefined)).toBeUndefined();
  });

  test("REQ-001-29 a Role's note names the model and the Role", () => {
    expect(agentNote({ role: "planner", modelId: "claude-opus-5-5", alias: "opus", owner: "octo" })).toBe(
      "> [!Note]\n> 🤖 Claude Opus 5.5 (Planner) writing on behalf of octo",
    );
  });

  test("REQ-001-29 without a known model id the note falls back to the configured model, never the Role", () => {
    expect(agentNote({ role: "implementer", alias: "sonnet", owner: "octo" })).toBe(
      "> [!Note]\n> 🤖 Claude Sonnet (Implementer) writing on behalf of octo",
    );
    expect(agentNote({ role: "reviewer", alias: "claude-opus-5-5", owner: "octo" })).toBe(
      "> [!Note]\n> 🤖 Claude Opus 5.5 (Reviewer) writing on behalf of octo",
    );
    expect(agentNote({ role: "reviewer", owner: "octo" })).toBe(
      "> [!Note]\n> 🤖 Claude (Reviewer) writing on behalf of octo",
    );
  });

  test("REQ-001-29 the Coordinator's own messages use the Coordinator note", () => {
    expect(agentNote({ owner: "octo" })).toBe("> [!Note]\n> 🤖 Coordinator writing on behalf of octo");
  });
});
