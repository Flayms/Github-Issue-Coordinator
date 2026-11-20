/**
 * A fake model server for smoke runs without a login (docs/harnesses.md): the OpenAI Responses API for Codex CLI, and
 * the Gemini API's `streamGenerateContent` for Antigravity CLI. Each request is answered with one assistant message;
 * when the prompt asks for a Result, the server writes a valid one to the path it names first, as a model would with
 * its file tool. Only for `scripts/smoke-runner.ts --fake-model`.
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

/** Writes the Result the latest prompt in the request asks for, if any. */
function writeResult(body: string): void {
  // The latest Result path in the conversation; JSON-escaped inside the request.
  const resultPath = [...body.matchAll(/write your Result as JSON to (\S+?result\.json)/g)].at(-1)?.[1];
  if (resultPath) writeFileSync(resultPath, JSON.stringify(fakeResult(body)));
}

/** The Gemini API's answer: one streamed chunk with the text "Done." (Antigravity CLI 1.5.12 sends `alt=sse`). */
const geminiDone = () =>
  new Response(
    `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    })}\r\n\r\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

/** The OpenAI Chat Completions API's answer, streamed: the text "Done." (OpenCode's `@ai-sdk/openai-compatible`). */
const chatDone = (n: number) => {
  const chunk = (delta: object, finish: string | null, usage?: object) =>
    `data: ${JSON.stringify({
      id: `chatcmpl_${n}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage && { usage }),
    })}\n\n`;
  return new Response(
    chunk({ role: "assistant", content: "Done." }, null) +
      chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
};

/**
 * Starts the server on a free port; `base_url` for Codex is `<url>/v1`, `GOOGLE_GEMINI_BASE_URL` for Antigravity
 * `<url>`, `baseURL` of an OpenAI-compatible provider (OpenCode) `<url>/v1`.
 */
export function startFakeModelServer(): { url: string; stop: () => void } {
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/models")) return Response.json({ data: [], models: [] });
      if (path.includes(":streamGenerateContent") && req.method === "POST") {
        writeResult(await req.text());
        return geminiDone();
      }
      if (path.endsWith("/chat/completions") && req.method === "POST") {
        writeResult(await req.text());
        return chatDone(++n);
      }
      if (!path.endsWith("/responses") || req.method !== "POST") return new Response("{}", { status: 404 });
      writeResult(await req.text());
      const id = `resp_${++n}`;
      const message = {
        type: "message",
        role: "assistant",
        id: `msg_${n}`,
        status: "completed",
        content: [{ type: "output_text", text: "Done." }],
      };
      return new Response(
        sse([
          { type: "response.created", response: { id } } as { type: string },
          // Copilot CLI takes the reply's text from its deltas; Codex from the finished item.
          {
            type: "response.output_text.delta",
            item_id: `msg_${n}`,
            output_index: 0,
            content_index: 0,
            delta: "Done.",
          } as { type: string },
          { type: "response.output_item.done", item: message } as { type: string },
          {
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output: [message],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          } as { type: string },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
