import { describe, expect, test } from "bun:test";
import {
  HARNESS_MODELS,
  inCatalogue,
  latestReported,
  MODEL_CATALOGUE,
  modelLabel,
  modelOptionLabel,
} from "../src/models.ts";

describe("Model catalogue", () => {
  test("REQ-003-40 offers each family as an alias and as a pinned version", () => {
    expect(MODEL_CATALOGUE.map((m) => m.value)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(MODEL_CATALOGUE.find((m) => m.value === "opus")).toEqual({
      value: "opus",
      label: "Opus (latest)",
      alias: true,
    });
    expect(MODEL_CATALOGUE.find((m) => m.value === "claude-opus-5-5")).toEqual({
      value: "claude-opus-5-5",
      label: "Opus 5.5",
      alias: false,
    });
  });

  test("REQ-003-40 only catalogue values are in the catalogue", () => {
    expect(inCatalogue("opus")).toBe(true);
    expect(inCatalogue("claude-haiku-5-5")).toBe(true);
    expect(inCatalogue("opus[1m]")).toBe(false);
    expect(inCatalogue("--dangerously-skip-permissions")).toBe(false);
    expect(inCatalogue("")).toBe(false);
  });

  test("REQ-003-41 names a model id by version, an alias as the latest, and keeps anything else", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("opus")).toBe("Opus (latest)");
    expect(modelLabel("Sonnet")).toBe("Sonnet (latest)");
    expect(modelLabel("opus[1m]")).toBe("Opus (latest), 1M context");
    expect(modelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5, 1M context");
    expect(modelLabel("opusplan")).toBe("opusplan");
    expect(modelLabel("–")).toBe("–");
  });

  test("REQ-003-40 an alias names the newest version a session reported for its family", () => {
    const reported = ["claude-opus-4-6", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5-1[1m]"];
    expect(latestReported("opus", reported)).toBe("Opus 5.5");
    expect(latestReported("haiku", reported)).toBeUndefined();
    expect(latestReported("claude-opus-5-5", reported)).toBeUndefined();
    expect(modelOptionLabel("opus", reported)).toBe("Opus (latest) · now Opus 5.5");
    expect(modelOptionLabel("opus", [])).toBe("Opus (latest)");
    expect(modelOptionLabel("claude-sonnet-5-5", reported)).toBe("Sonnet 5.5");
  });

  test("REQ-006-07 Copilot's models stay apart from the same vendors' models on their own Harness", () => {
    const copilot = HARNESS_MODELS.copilot.map((m) => m.value);
    expect(copilot.length).toBeGreaterThan(0);
    for (const v of copilot) expect(v).toStartWith("copilot:");
    expect(copilot).toContain("copilot:claude-sonnet-5.5");
    expect(copilot).toContain("copilot:gpt-6.1-sol");
    expect(inCatalogue("copilot:claude-sonnet-5.5")).toBe(true);
    expect(modelLabel("copilot:claude-sonnet-5.5")).toBe("Claude Sonnet 5.5 (Copilot)");
    expect(modelLabel("copilot:auto")).toBe("Auto (Copilot)");
    expect(modelLabel("copilot:some-new-model")).toBe("some-new-model (Copilot)");
  });
});
