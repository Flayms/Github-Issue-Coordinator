/**
 * A fake OpenAI Responses API for smoke runs of Codex CLI without a login (docs/harnesses.md). Each request is
 * answered with one assistant message; when the prompt asks for a Result, the server writes a valid one to the path
 * it names first, as a model would with its file tool. Only for `scripts/smoke-runner.ts --fake-model`.
 */
import { writeFileSync } from "node:fs";

/** What the fake "model" writes as the Result: an Implementer's or a Reviewer's, after the schema the prompt shows. */
function fakeResult(prompt: string): object {
  const summary = prompt.includes("Second turn") ? "resumed: fake turn" : "fake turn";
  // The schema is JSON-escaped inside the request body.
  return prompt.includes("prTitle")
    ? { prTitle: "smoke", prBody: "smoke", summary }
    : { summary, findings: [], risk: "low", riskReason: "smoke run with a fake model" };
}

const sse = (events: { type: string }[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** Starts the server on a free port; `base_url` for Codex is `<url>/v1`. */
export function startFakeModelServer(): { url: string; stop: () => void } {
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/models")) return Response.json({ data: [], models: [] });
      if (!path.endsWith("/responses") || req.method !== "POST") return new Response("{}", { status: 404 });
      const body = await req.text();
      // The latest Result path in the conversation; JSON-escaped inside the request.
      const resultPath = [...body.matchAll(/write your Result as JSON to (\S+?result\.json)/g)].at(-1)?.[1];
      if (resultPath) writeFileSync(resultPath, JSON.stringify(fakeResult(body)));
      const id = `resp_${++n}`;
      return new Response(
        sse([
          { type: "response.created", response: { id } } as { type: string },
          {
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              id: `msg_${n}`,
              content: [{ type: "output_text", text: "Done." }],
            },
          } as { type: string },
          {
            type: "response.completed",
            response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          } as { type: string },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
