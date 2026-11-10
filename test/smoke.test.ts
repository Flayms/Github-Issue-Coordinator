import { expect, test } from "bun:test";
import { NAME } from "../src/index.ts";

test("tooling smoke: the entry module loads", () => {
  expect(NAME).toBe("github-issue-coordinator");
});
