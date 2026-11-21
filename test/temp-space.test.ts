import { describe, expect, test } from "bun:test";
import { LOW_TEMP_SPACE_BYTES, tempSpaceChecks } from "../src/temp-space.ts";

const GB = 1024 ** 3;

describe("REQ-005-08 doctor warns about low temp space", () => {
  test("warns, naming the volume and its free space, when one has less than 1 GB free", () => {
    const free = new Map([
      ["/srv/coordinator/.issueflow", 27 * GB],
      ["/tmp", 11 * 1024 ** 2],
    ]);
    expect(tempSpaceChecks({ sessions: "/srv/coordinator/.issueflow", tmp: "/tmp" }, (p) => free.get(p) ?? 0)).toEqual([
      { status: "ok", check: "free space for session folders", detail: "/srv/coordinator/.issueflow: 27.0 GB free" },
      {
        status: "warn",
        check: "free space in /tmp",
        detail: "/tmp: only 11 MB free (below 1.0 GB); agent sessions may fail with ENOSPC",
      },
    ]);
  });

  test("is ok above the threshold, and the default threshold is 1 GB", () => {
    expect(LOW_TEMP_SPACE_BYTES).toBe(GB);
    expect(tempSpaceChecks({ sessions: "/state", tmp: "/tmp" }, () => 2 * GB).map((c) => c.status)).toEqual([
      "ok",
      "ok",
    ]);
    expect(tempSpaceChecks({ sessions: "/state", tmp: "/tmp" }, () => GB - 1).map((c) => c.status)).toEqual([
      "warn",
      "warn",
    ]);
  });

  test("a folder whose free space can't be read is a warning, not an error", () => {
    const [c] = tempSpaceChecks({ sessions: "/nope", tmp: "/tmp" }, (p) => {
      if (p === "/tmp") return 2 * GB;
      throw new Error("ENOENT");
    });
    expect(c).toMatchObject({ status: "warn", check: "free space for session folders" });
    expect(c?.detail).toContain("ENOENT");
  });
});
