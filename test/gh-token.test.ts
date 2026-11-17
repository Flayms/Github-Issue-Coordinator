import { describe, expect, test } from "bun:test";
import { GhToken } from "../src/github/gh-token.ts";

describe("gh token", () => {
  test("REQ-005-02 reads the token from gh auth token, the same for every repository", async () => {
    const calls: string[][] = [];
    const t = new GhToken({
      run: (cmd) => {
        calls.push(cmd);
        return { ok: true, out: "github_pat_1\n" };
      },
    });
    expect(await t.tokenFor("octo/app")).toBe("github_pat_1");
    expect(await t.tokenFor("octo/lib")).toBe("github_pat_1");
    expect(calls).toEqual([["gh", "auth", "token"]]);
  });

  test("REQ-005-02 reads it again after 5 minutes, so a token changed with gh needs no restart", async () => {
    let now = 0;
    let token = "github_pat_1";
    const t = new GhToken({ run: () => ({ ok: true, out: token }), now: () => now });
    expect(await t.tokenFor("octo/app")).toBe("github_pat_1");
    token = "github_pat_2";
    now = 5 * 60_000 - 1;
    expect(await t.tokenFor("octo/app")).toBe("github_pat_1");
    now = 5 * 60_000;
    expect(await t.tokenFor("octo/app")).toBe("github_pat_2");
  });

  test("REQ-005-02 a failing gh says how to log in, and is asked again next time", async () => {
    let ok = false;
    const t = new GhToken({
      run: () => (ok ? { ok: true, out: "github_pat_1" } : { ok: false, out: "not logged in" }),
    });
    await expect(t.tokenFor("octo/app")).rejects.toThrow(/gh auth login.*not logged in/);
    ok = true;
    expect(await t.tokenFor("octo/app")).toBe("github_pat_1");
  });

  test("REQ-005-02 an empty token is an error", async () => {
    const t = new GhToken({ run: () => ({ ok: true, out: "  \n" }) });
    await expect(t.tokenFor("octo/app")).rejects.toThrow(/gh auth login/);
  });
});
