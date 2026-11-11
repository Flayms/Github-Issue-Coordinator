/**
 * The Coordinator's GitHub REST client. It performs every comment, label, review and PR action
 * on behalf of the agents (REQ-001-15) and returns plain domain objects.
 */
import { AGENT_LABELS } from "../labels.ts";
import type { AppAuth } from "./app-auth.ts";
import { API, baseHeaders, errorFrom, type Fetch, GitHubError } from "./http.ts";

export interface Actor {
  login: string;
  /** Numeric user id; authorship checks compare this, never the login (REQ-001-01). */
  id: number;
}

/** An open issue or PR, as listed by the issues endpoint. */
export interface Item {
  number: number;
  title: string;
  body: string;
  author: Actor;
  labels: string[];
  isPullRequest: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  author: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export type ChecksState = "none" | "pending" | "success" | "failure";

export interface Pull {
  number: number;
  headSha: string;
  headRef: string;
  baseRef: string;
}

interface RawUser {
  login: string;
  id: number;
}
const actor = (u: RawUser): Actor => ({ login: u.login, id: u.id });

/** Check conclusions that don't count as failing. */
const PASSING = new Set(["success", "neutral", "skipped"]);

interface Page<T> {
  data: T;
  next?: string;
  etag?: string;
  notModified: boolean;
}

export class GitHubClient {
  private readonly fetch: Fetch;
  private readonly etagCache = new Map<string, { etag: string; items: Item[] }>();

  constructor(private readonly opts: { auth: AppAuth; fetch?: Fetch }) {
    this.fetch = opts.fetch ?? fetch;
  }

  /**
   * All open issues and PRs of a repository. Sends the ETag of the previous poll; on 304 the
   * cached list is returned with `changed: false`.
   */
  async listOpenItems(repo: string): Promise<{ changed: boolean; items: Item[] }> {
    const path = `/repos/${repo}/issues?state=open&per_page=100`;
    const cached = this.etagCache.get(repo);
    const first = await this.page<RawItem[]>(repo, path, cached?.etag);
    if (first.notModified && cached) return { changed: false, items: cached.items };
    const raw = [...first.data, ...(await this.rest<RawItem>(repo, first.next))];
    const items = raw.map(toItem);
    if (first.etag) this.etagCache.set(repo, { etag: first.etag, items });
    return { changed: true, items };
  }

  /** Comments on an issue or PR, oldest first; with `afterId`, only newer ones. */
  async listComments(repo: string, issue: number, opts: { afterId?: number } = {}): Promise<Comment[]> {
    const raw = await this.all<RawComment>(repo, `/repos/${repo}/issues/${issue}/comments?per_page=100`);
    return raw
      .filter((c) => c.id > (opts.afterId ?? 0))
      .map((c) => ({
        id: c.id,
        body: c.body ?? "",
        author: actor(c.user),
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      }));
  }

  /** Who most recently added `label` to the issue, from its timeline (REQ-001-04). */
  async labelActor(repo: string, issue: number, label: string): Promise<Actor | undefined> {
    const events = await this.all<RawTimelineEvent>(repo, `/repos/${repo}/issues/${issue}/timeline?per_page=100`);
    const last = events.findLast((e) => e.event === "labeled" && e.label?.name === label);
    return last?.actor ? actor(last.actor) : undefined;
  }

  async addLabels(repo: string, issue: number, labels: string[]): Promise<void> {
    await this.request(repo, "POST", `/repos/${repo}/issues/${issue}/labels`, { labels });
  }

  /** Removes a label; a label that is already gone is fine. */
  async removeLabel(repo: string, issue: number, label: string): Promise<void> {
    try {
      await this.request(repo, "DELETE", `/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) throw e;
    }
  }

  /** Creates the `agent:*` labels that the repository doesn't have yet. */
  async ensureAgentLabels(repo: string): Promise<void> {
    const existing = new Set(
      (await this.all<{ name: string }>(repo, `/repos/${repo}/labels?per_page=100`)).map((l) => l.name),
    );
    for (const label of AGENT_LABELS) {
      if (!existing.has(label.name)) await this.request(repo, "POST", `/repos/${repo}/labels`, label);
    }
  }

  async createComment(repo: string, issue: number, body: string): Promise<number> {
    return (await this.request<{ id: number }>(repo, "POST", `/repos/${repo}/issues/${issue}/comments`, { body })).id;
  }

  async updateComment(repo: string, commentId: number, body: string): Promise<void> {
    await this.request(repo, "PATCH", `/repos/${repo}/issues/comments/${commentId}`, { body });
  }

  async createPull(repo: string, pr: { title: string; body: string; head: string; base: string }): Promise<number> {
    return (await this.request<{ number: number }>(repo, "POST", `/repos/${repo}/pulls`, pr)).number;
  }

  async updatePull(repo: string, pr: number, patch: { title?: string; body?: string }): Promise<void> {
    await this.request(repo, "PATCH", `/repos/${repo}/pulls/${pr}`, patch);
  }

  /** Posts a Review on the given head commit. The event is always COMMENT (REQ-001-10). */
  async createReview(
    repo: string,
    pr: number,
    review: { commitId: string; body: string; comments: ReviewComment[] },
  ): Promise<void> {
    await this.request(repo, "POST", `/repos/${repo}/pulls/${pr}/reviews`, {
      commit_id: review.commitId,
      body: review.body,
      event: "COMMENT",
      comments: review.comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
    });
  }

  /** A PR's head commit and branches (REQ-001-10). */
  async getPull(repo: string, pr: number): Promise<Pull> {
    const r = await this.request<RawPull>(repo, "GET", `/repos/${repo}/pulls/${pr}`);
    return { number: r.number, headSha: r.head.sha, headRef: r.head.ref, baseRef: r.base.ref };
  }

  /** Summary of the check runs on a commit, with the names of failed ones. */
  async checks(repo: string, sha: string): Promise<{ state: ChecksState; failed: string[] }> {
    const runs: RawCheckRun[] = [];
    let url: string | undefined = `/repos/${repo}/commits/${sha}/check-runs?per_page=100`;
    while (url) {
      const page: Page<{ check_runs: RawCheckRun[] }> = await this.page(repo, url);
      runs.push(...page.data.check_runs);
      url = page.next;
    }
    const failed = runs.filter((r) => r.status === "completed" && !PASSING.has(r.conclusion ?? "")).map((r) => r.name);
    const state: ChecksState =
      runs.length === 0
        ? "none"
        : failed.length > 0
          ? "failure"
          : runs.some((r) => r.status !== "completed")
            ? "pending"
            : "success";
    return { state, failed };
  }

  // --- plumbing ---

  private async headers(repo: string): Promise<Record<string, string>> {
    return { ...baseHeaders, authorization: `token ${await this.opts.auth.tokenFor(repo)}` };
  }

  private async request<T = unknown>(repo: string, method: string, path: string, body?: unknown): Promise<T> {
    const headers = await this.headers(repo);
    const res = await this.fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await errorFrom(res, method, path);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** One GET page; `pathOrUrl` may be a path or an absolute `next` link. */
  private async page<T>(repo: string, pathOrUrl: string, etag?: string): Promise<Page<T>> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
    const headers = await this.headers(repo);
    const res = await this.fetch(url, { headers: etag ? { ...headers, "if-none-match": etag } : headers });
    if (res.status === 304) return { data: undefined as T, notModified: true };
    if (!res.ok) throw await errorFrom(res, "GET", new URL(url).pathname);
    return {
      data: (await res.json()) as T,
      next: nextLink(res.headers.get("link")),
      etag: res.headers.get("etag") ?? undefined,
      notModified: false,
    };
  }

  private async rest<T>(repo: string, next: string | undefined): Promise<T[]> {
    const out: T[] = [];
    while (next) {
      const page: Page<T[]> = await this.page(repo, next);
      out.push(...page.data);
      next = page.next;
    }
    return out;
  }

  private async all<T>(repo: string, path: string): Promise<T[]> {
    const first = await this.page<T[]>(repo, path);
    return [...first.data, ...(await this.rest<T>(repo, first.next))];
  }
}

function nextLink(link: string | null): string | undefined {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}

interface RawItem {
  number: number;
  title: string;
  body: string | null;
  user: RawUser;
  labels: (string | { name: string })[];
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
}

const toItem = (r: RawItem): Item => ({
  number: r.number,
  title: r.title,
  body: r.body ?? "",
  author: actor(r.user),
  labels: r.labels.map((l) => (typeof l === "string" ? l : l.name)),
  isPullRequest: r.pull_request !== undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface RawComment {
  id: number;
  body: string | null;
  user: RawUser;
  created_at: string;
  updated_at: string;
}

interface RawTimelineEvent {
  event: string;
  label?: { name: string };
  actor?: RawUser;
}

interface RawPull {
  number: number;
  head: { sha: string; ref: string };
  base: { ref: string };
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}
