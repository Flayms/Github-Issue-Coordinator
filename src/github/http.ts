export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    detail: string,
  ) {
    super(`GitHub ${method} ${path} failed with ${status}: ${detail}`);
    this.name = "GitHubError";
  }
}

export const baseHeaders = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "github-issue-coordinator",
};

export async function errorFrom(res: Response, method: string, path: string): Promise<GitHubError> {
  const text = await res.text().catch(() => "");
  let detail = text;
  try {
    detail = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {}
  return new GitHubError(res.status, method, path, detail || res.statusText);
}
