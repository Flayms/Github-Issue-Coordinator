#!/usr/bin/env bun
/**
 * Claude Code hook for Coordinator sessions, configured per session through `--settings`.
 * Usage: bun src/hook.ts <event> <dbPath> <sessionId> <sessionDir>   (payload JSON on stdin)
 *
 * - SessionStart: records Claude's session id (needed to resume) and the model it runs (REQ-001-29).
 * - UserPromptSubmit: marks the session running; a prompt after the Coordinator's own is the Owner's (REQ-001-19).
 * - Stop: validates the Result and blocks the stop while it is invalid, up to 3 times (REQ-001-21);
 *   otherwise marks the session idle and queues a sync (REQ-001-19). A turn cut off by the usage
 *   limit is never blocked (REQ-001-17).
 * - StatusLine: run as the session's status line command, not as a hook; records the Account's Usage quota and
 *   prints it for the session's window (REQ-001-67).
 * Every hook payload is appended to <sessionDir>/events.jsonl (usage-limit format still unknown, T0 (e)); the status
 * line's are not, since it runs after every message.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findingsToAnswer, resultInstructions, validateResult } from "./results.ts";
import { type QuotaWindow, Store, type UsageQuota } from "./store.ts";

export const MAX_RESULT_FAILURES = 3;

export interface HookInput {
  event: string;
  payload: Record<string, unknown>;
  store: Store;
  sessionId: number;
  sessionDir: string;
}

export function handleHook({ event, payload, store, sessionId, sessionDir }: HookInput): { stdout?: string } {
  if (event === "StatusLine") return statusLine(payload, store, sessionId);
  appendFileSync(
    join(sessionDir, "events.jsonl"),
    `${JSON.stringify({ t: new Date().toISOString(), event, payload })}\n`,
  );
  const session = store.session(sessionId);
  if (!session) return {};

  switch (event) {
    case "SessionStart":
      if (typeof payload.session_id === "string") store.setClaudeSessionId(sessionId, payload.session_id);
      if (typeof payload.model === "string" && payload.model) store.setModelId(sessionId, payload.model);
      return {};

    case "UserPromptSubmit":
      if (session.coordinatorPromptPending)
        store.patchSession(sessionId, { state: "running", coordinatorPromptPending: false });
      else store.patchSession(sessionId, { state: "running", ownerMessagedAt: new Date(nowOf(store)).toISOString() });
      return {};

    case "Stop": {
      if (!session.modelId) {
        const model = transcriptModel(payload.transcript_path);
        if (model) store.setModelId(sessionId, model);
      }
      if (usageLimitText(payload.transcript_path)) {
        store.patchSession(sessionId, { state: "idle", usageLimited: true });
        return {};
      }
      const resultPath = join(sessionDir, "result.json");
      const text = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : undefined;
      const findings =
        session.role === "implementer" ? findingsToAnswer(store.issue(session.repo, session.issues[0] ?? 0)) : 0;
      const check = validateResult(session.role, text, session.issues, findings);
      if (check.ok) {
        store.patchSession(sessionId, { state: "idle", needsSync: true, resultFailures: 0 });
        return {};
      }
      if (session.resultFailures >= MAX_RESULT_FAILURES) {
        // Give up: the Coordinator labels the issue agent:failed when it syncs.
        store.patchSession(sessionId, { state: "idle", needsSync: true });
        return {};
      }
      store.patchSession(sessionId, { resultFailures: session.resultFailures + 1 });
      const reason = `${check.problem} ${resultInstructions(session.role, resultPath)}`;
      return { stdout: JSON.stringify({ decision: "block", reason }) };
    }

    default:
      return {};
  }
}

/** REQ-001-67: records the Usage quota of the session's Account and prints it; anything unexpected is ignored. */
function statusLine(payload: Record<string, unknown>, store: Store, sessionId: number): { stdout?: string } {
  const account = store.session(sessionId)?.account;
  const report = rateLimits(payload.rate_limits);
  if (!account || !report) return {};
  store.recordUsageQuota(account, report);
  const quota = store.usageQuota(account);
  return quota ? { stdout: quotaLine(quota) } : {};
}

/** The windows of Claude Code's `rate_limits`; undefined when it holds none that are well-formed. */
export function rateLimits(value: unknown): { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const fiveHour = quotaWindow(v.five_hour);
  const sevenDay = quotaWindow(v.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) };
}

/** `{ used_percentage: 0–100, resets_at: Unix seconds }`, as documented for status line commands. */
function quotaWindow(value: unknown): QuotaWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { used_percentage: used, resets_at: resets } = value as Record<string, unknown>;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return undefined;
  if (typeof resets !== "number" || !Number.isFinite(resets) || resets <= 0) return undefined;
  return { usedPercent: used, resetsAt: new Date(resets * 1000).toISOString() };
}

/** What the session's status line shows, e.g. `5-hour 38% · weekly 24% used`. */
const quotaLine = (q: UsageQuota): string => {
  const pct = (w: QuotaWindow | null) => (w ? `${Math.round(w.usedPercent)}%` : "–");
  return `5-hour ${pct(q.fiveHour)} · weekly ${pct(q.sevenDay)} used`;
};

/** The store's clock, so tests can control time. */
const nowOf = (store: Store): number => store.clock().getTime();

/** The model of the transcript's first assistant entry; a fallback if SessionStart named none (REQ-001-29). */
export function transcriptModel(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== "string" || !existsSync(transcriptPath)) return undefined;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    let entry: { type?: string; isApiErrorMessage?: boolean; message?: { model?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || entry.isApiErrorMessage) continue;
    const model = entry.message?.model;
    // Synthetic replies use the model "<synthetic>".
    if (typeof model === "string" && model.startsWith("claude")) return model;
  }
  return undefined;
}

/**
 * The text of the transcript's last entry if it is an API error about a limit. Unverified shape:
 * Claude Code marks synthetic error replies with `isApiErrorMessage` (see docs/known-pitfalls.md).
 */
export function usageLimitText(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== "string" || !existsSync(transcriptPath)) return undefined;
  const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i--) {
    let entry: { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(lines[i] ?? "");
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    if (entry.isApiErrorMessage !== true) return undefined;
    const text = JSON.stringify(entry.message?.content ?? "");
    return /limit/i.test(text) ? text : undefined;
  }
  return undefined;
}

if (import.meta.main) {
  const [event = "unknown", dbPath = "", id = "0", sessionDir = "."] = Bun.argv.slice(2);
  try {
    const raw = await Bun.stdin.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
    const store = new Store(dbPath);
    const out = handleHook({ event, payload, store, sessionId: Number(id), sessionDir });
    store.close();
    if (out.stdout) console.log(out.stdout);
  } catch (e) {
    // Never break the session; leave a trace for the Coordinator's logs.
    try {
      appendFileSync(join(sessionDir, "hook-errors.log"), `${new Date().toISOString()} ${event} ${String(e)}\n`);
    } catch {}
  }
  process.exit(0);
}
