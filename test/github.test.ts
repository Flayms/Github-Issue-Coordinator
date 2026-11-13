import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { AppAuth, createAppJwt } from "../src/github/app-auth.ts";
import { GitHubClient } from "../src/github/client.ts";
import { GitHubError } from "../src/github/http.ts";
import { AGENT_LABELS } from "../src/labels.ts";
import { fakeFetch } from "./support/fake-fetch.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const NOW = new Date("2026-11-10T12:00:00Z");

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());

const installationRoutes = (tokens: string[] = ["tok-1", "tok-2"]) => ({
  "GET /repos/octo/app/installation": { body: { id: 99 } },
  "GET /repos/octo/lib/installation": { body: { id: 99 } },
  "POST /app/installations/99/access_tokens": () => ({
    status: 201,
    body: { token: tokens.shift(), expires_at: "2026-11-10T13:00:00Z" },
  }),
});

function client(routes: Parameters<typeof fakeFetch>[0], clock = () => NOW) {
  const fake = fakeFetch({ ...installationRoutes(), ...routes });
  const auth = new AppAuth({ appId: 7, privateKey: pem, fetch: fake.fetch, now: clock });
  return { gh: new GitHubClient({ auth, fetch: fake.fetch }), ...fake };
}

const apiRequests = (requests: ReturnType<typeof fakeFetch>["requests"]) =>
  requests.filter((r) => !r.url.pathname.endsWith("/installation") && !r.url.pathname.endsWith("/access_tokens"));

describe("GitHub App auth", () => {
  test("REQ-001-15 signs an RS256 app JWT, backdated for clock drift and valid under 10 minutes", () => {
    const jwt = createAppJwt(7, pem, NOW);
    const [h = "", p = "", s = ""] = jwt.split(".");
    expect(b64json(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const now = NOW.getTime() / 1000;
    expect(b64json(p)).toEqual({ iss: "7", iat: now - 60, exp: now + 540 });
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(pem), Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });

  test("REQ-001-15 mints an installation token per repository and caches it until shortly before expiry", async () => {
    let now = NOW;
    const { gh, requests } = client({ "GET /repos/octo/app/issues": { body: [] } }, () => now);
    await gh.listOpenItems("octo/app");
    await gh.listOpenItems("octo/app");
    const mints = requests.filter((r) => r.url.pathname.endsWith("/access_tokens"));
    expect(mints).toHaveLength(1);
    expect(mints[0]?.headers.get("authorization")).toStartWith("Bearer ey");
    expect(apiRequests(requests).map((r) => r.headers.get("authorization"))).toEqual(["token tok-1", "token tok-1"]);

    now = new Date("2026-11-10T12:56:00Z"); // < 5 minutes left
    await gh.listOpenItems("octo/app");
    expect(apiRequests(requests).at(-1)?.headers.get("authorization")).toBe("token tok-2");
  });
});

describe("GitHub client", () => {
  const rawIssue = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    title: `Issue ${n}`,
    body: "body",
    user: { login: "octo", id: 42 },
    labels: [{ name: "agent:proposed" }, { name: "bug" }],
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    ...extra,
  });

  test("REQ-001-01 lists open issues and PRs with their author's numeric id, following pagination", async () => {
    const { gh } = client({
      "GET /repos/octo/app/issues": (req) =>
        req.url.searchParams.get("page") === "2"
          ? { body: [rawIssue(3, { pull_request: { url: "x" }, body: null })] }
          : {
              body: [rawIssue(1), rawIssue(2)],
              headers: { link: '<https://api.github.com/repos/octo/app/issues?state=open&page=2>; rel="next"' },
            },
    });
    const res = await gh.listOpenItems("octo/app");
    expect(res.changed).toBe(true);
    expect(res.items.map((i) => [i.number, i.isPullRequest])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(res.items[0]).toEqual({
      number: 1,
      title: "Issue 1",
      body: "body",
      author: { login: "octo", id: 42 },
      labels: ["agent:proposed", "bug"],
      isPullRequest: false,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-02T00:00:00Z",
    });
    expect(res.items[2]?.body).toBe("");
  });

  test("polls with the ETag and returns the cached list unchanged on 304", async () => {
    const { gh, requests } = client({
      "GET /repos/octo/app/issues": (req) =>
        req.headers.get("if-none-match") === '"v1"'
          ? { status: 304 }
          : { body: [rawIssue(1)], headers: { etag: '"v1"' } },
    });
    const first = await gh.listOpenItems("octo/app");
    const second = await gh.listOpenItems("octo/app");
    expect(first.changed).toBe(true);
    expect(second).toEqual({ changed: false, items: first.items });
    expect(apiRequests(requests)[1]?.headers.get("if-none-match")).toBe('"v1"');
  });

  test("REQ-001-04 finds who added a label most recently from the issue timeline", async () => {
    const { gh } = client({
      "GET /repos/octo/app/issues/5/timeline": {
        body: [
          { event: "labeled", label: { name: "agent:approved" }, actor: { login: "octo", id: 42 } },
          { event: "unlabeled", label: { name: "agent:approved" }, actor: { login: "bot", id: 1 } },
          { event: "labeled", label: { name: "agent:approved" }, actor: { login: "mallory", id: 666 } },
          { event: "labeled", label: { name: "bug" }, actor: { login: "octo", id: 42 } },
          { event: "commented", actor: { login: "octo", id: 42 } },
        ],
      },
    });
    expect(await gh.labelActor("octo/app", 5, "agent:approved")).toEqual({ login: "mallory", id: 666 });
    expect(await gh.labelActor("octo/app", 5, "agent:blocked")).toBeUndefined();
  });

  test("REQ-001-01 lists comments with author ids, only those after a given id", async () => {
    const { gh, requests } = client({
      "GET /repos/octo/app/issues/5/comments": {
        body: [
          { id: 10, body: "old", user: { login: "octo", id: 42 }, created_at: "a", updated_at: "a" },
          { id: 11, body: "/approve go", user: { login: "octo", id: 42 }, created_at: "b", updated_at: "c" },
        ],
      },
    });
    const comments = await gh.listComments("octo/app", 5, { afterId: 10 });
    expect(comments).toEqual([
      { id: 11, body: "/approve go", author: { login: "octo", id: 42 }, createdAt: "b", updatedAt: "c" },
    ]);
    expect(apiRequests(requests)[0]?.url.searchParams.get("per_page")).toBe("100");
  });

  test("edits labels; removing a label that is already gone is not an error", async () => {
    const { gh, requests } = client({
      "POST /repos/octo/app/issues/5/labels": { body: [] },
      "DELETE /repos/octo/app/issues/5/labels/agent:planning": {
        status: 404,
        body: { message: "Label does not exist" },
      },
    });
    await gh.addLabels("octo/app", 5, ["agent:proposed"]);
    await gh.removeLabel("octo/app", 5, "agent:planning");
    expect(apiRequests(requests).map((r) => [r.method, r.url.pathname, r.body])).toEqual([
      ["POST", "/repos/octo/app/issues/5/labels", { labels: ["agent:proposed"] }],
      ["DELETE", "/repos/octo/app/issues/5/labels/agent:planning", undefined],
    ]);
  });

  test("creates only the agent labels a repository is missing", async () => {
    const { gh, requests } = client({
      "GET /repos/octo/app/labels": { body: [{ name: "agent:approved" }, { name: "bug" }] },
      "POST /repos/octo/app/labels": (req) => ({ status: 201, body: req.body }),
    });
    await gh.ensureAgentLabels("octo/app");
    const created = apiRequests(requests)
      .filter((r) => r.method === "POST")
      .map((r) => (r.body as { name: string }).name);
    expect(created).toEqual(AGENT_LABELS.map((l) => l.name).filter((n) => n !== "agent:approved"));
  });

  test("REQ-001-31 posts and edits comments, creates PRs as drafts and updates them", async () => {
    const { gh, requests } = client({
      "POST /repos/octo/app/issues/5/comments": { status: 201, body: { id: 77 } },
      "PATCH /repos/octo/app/issues/comments/77": { body: { id: 77 } },
      "POST /repos/octo/app/pulls": { status: 201, body: { number: 9 } },
      "PATCH /repos/octo/app/pulls/9": { body: { number: 9 } },
    });
    expect(await gh.createComment("octo/app", 5, "Assessment")).toBe(77);
    await gh.updateComment("octo/app", 77, "Assessment v2");
    expect(await gh.createPull("octo/app", { title: "T", body: "B", head: "agent/5-x", base: "main" })).toBe(9);
    await gh.updatePull("octo/app", 9, { body: "B2" });
    expect(apiRequests(requests).map((r) => r.body)).toEqual([
      { body: "Assessment" },
      { body: "Assessment v2" },
      { title: "T", body: "B", head: "agent/5-x", base: "main", draft: true },
      { body: "B2" },
    ]);
  });

  test("REQ-001-10 posts a Review pinned to the head commit, always with event COMMENT", async () => {
    const { gh, requests } = client({ "POST /repos/octo/app/pulls/9/reviews": { body: { id: 1 } } });
    await gh.createReview("octo/app", 9, {
      commitId: "abc123",
      body: "Summary",
      comments: [{ path: "src/a.ts", line: 3, body: "Off by one" }],
    });
    expect(apiRequests(requests)[0]?.body).toEqual({
      commit_id: "abc123",
      body: "Summary",
      event: "COMMENT",
      comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "Off by one" }],
    });
  });

  test("REQ-001-10 / REQ-001-28 reads a PR's head commit, base branch and whether it can be merged", async () => {
    for (const mergeable of [true, false, null]) {
      const { gh } = client({
        "GET /repos/octo/app/pulls/9": {
          body: {
            number: 9,
            node_id: "PR_9",
            state: "open",
            draft: true,
            head: { sha: "abc", ref: "agent/5-x" },
            base: { ref: "main" },
            mergeable,
          },
        },
      });
      expect(await gh.getPull("octo/app", 9)).toEqual({
        number: 9,
        nodeId: "PR_9",
        draft: true,
        headSha: "abc",
        headRef: "agent/5-x",
        baseRef: "main",
        mergeable,
      });
    }
  });

  const pullAs = (draft: boolean) => ({
    body: { number: 9, node_id: "PR_9", draft, head: { sha: "abc", ref: "b" }, base: { ref: "main" }, mergeable: true },
  });

  test("REQ-001-31 marks a draft PR ready for review and converts a ready PR to draft through GraphQL", async () => {
    for (const [from, to, mutation] of [
      [true, false, "markPullRequestReadyForReview"],
      [false, true, "convertPullRequestToDraft"],
    ] as const) {
      const { gh, requests } = client({
        "GET /repos/octo/app/pulls/9": pullAs(from),
        "POST /graphql": { body: { data: {} } },
      });
      await gh.setDraft("octo/app", 9, to);
      const call = apiRequests(requests).find((r) => r.url.pathname === "/graphql");
      const body = call?.body as { query: string; variables: unknown };
      expect(body.query).toContain(mutation);
      expect(body.variables).toEqual({ id: "PR_9" });
    }
  });

  test("REQ-001-31 changing the draft status is skipped when the PR already has it", async () => {
    const { gh, requests } = client({ "GET /repos/octo/app/pulls/9": pullAs(true) });
    await gh.setDraft("octo/app", 9, true);
    expect(apiRequests(requests).some((r) => r.url.pathname === "/graphql")).toBe(false);
  });

  test("REQ-001-31 a GraphQL error is thrown", async () => {
    const { gh } = client({
      "GET /repos/octo/app/pulls/9": pullAs(true),
      "POST /graphql": { body: { errors: [{ message: "Resource not accessible by integration" }] } },
    });
    await expect(gh.setDraft("octo/app", 9, false)).rejects.toThrow("Resource not accessible by integration");
  });

  test("REQ-001-12 lists PR reviews with their author and state", async () => {
    const { gh } = client({
      "GET /repos/octo/app/pulls/9/reviews": {
        body: [{ id: 3, state: "CHANGES_REQUESTED", body: "Please split it", user: { login: "octo", id: 42 } }],
      },
    });
    expect(await gh.listReviews("octo/app", 9)).toEqual([
      { id: 3, state: "CHANGES_REQUESTED", body: "Please split it", author: { login: "octo", id: 42 } },
    ]);
  });

  test("REQ-001-13 failed checks carry their output summary", async () => {
    const { gh } = client({
      "GET /repos/octo/app/commits/abc/check-runs": {
        body: {
          check_runs: [
            {
              name: "test",
              status: "completed",
              conclusion: "failure",
              output: { title: "2 failed", summary: "foo.test.ts" },
            },
          ],
        },
      },
    });
    expect((await gh.checks("octo/app", "abc")).failed).toEqual(["test: 2 failed — foo.test.ts"]);
  });

  test("REQ-001-10 summarises check runs on a commit as none, pending, success or failure", async () => {
    const runs = (...r: { status: string; conclusion: string | null; name?: string }[]) => ({
      "GET /repos/octo/app/commits/abc/check-runs": { body: { total_count: r.length, check_runs: r } },
    });
    const state = async (routes: ReturnType<typeof runs>) => (await client(routes).gh.checks("octo/app", "abc")).state;
    expect(await state(runs())).toBe("none");
    expect(
      await state(runs({ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null })),
    ).toBe("pending");
    expect(
      await state(runs({ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" })),
    ).toBe("success");
    const failed = await client(
      runs(
        { status: "completed", conclusion: "failure", name: "test" },
        { status: "completed", conclusion: "success", name: "lint" },
      ),
    ).gh.checks("octo/app", "abc");
    expect(failed).toEqual({ state: "failure", failed: ["test"] });
  });

  test("throws a GitHubError with status and message on other errors", async () => {
    const { gh } = client({
      "GET /repos/octo/app/issues": { status: 403, body: { message: "Resource not accessible" } },
    });
    const err = await gh.listOpenItems("octo/app").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ status: 403, message: expect.stringContaining("Resource not accessible") });
  });
});
