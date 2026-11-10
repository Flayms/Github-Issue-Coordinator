import type { Fetch } from "../../src/github/http.ts";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (req: RecordedRequest) => Reply;

/** Minimal fake of the GitHub REST API: routes are `METHOD /path` (query ignored), first match wins. */
export function fakeFetch(routes: Record<string, Handler | Reply>) {
  const requests: RecordedRequest[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    url.pathname = decodeURIComponent(url.pathname);
    const method = init?.method ?? "GET";
    const req: RecordedRequest = {
      method,
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const reply = typeof route === "function" ? route(req) : route;
    const status = reply.status ?? 200;
    const body = status === 204 || status === 304 ? null : JSON.stringify(reply.body ?? {});
    return new Response(body, { status, headers: reply.headers });
  };
  return { fetch, requests };
}
