/**
 * Reads what a session is doing from its Claude Code transcript (JSONL), for the dashboard's Now line
 * (REQ-003-42) and its Open chat link (REQ-003-43). Read only: it never writes to the transcript.
 *
 * The transcript's shape is internal to Claude Code and undocumented (see docs/known-pitfalls.md), so every
 * entry is parsed defensively: anything unexpected is skipped, and nothing found means no line and no link.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Only the transcript's tail is read for the Now line, so a transcript of tens of MB costs the same (REQ-003-42). */
export const TAIL_BYTES = 64 * 1024;
/** A step's text is cut to this many characters; the page truncates further and shows this as the tooltip. */
const MAX_TEXT = 300;
/** Chunk size of the scan for the Remote Control URL. */
const SCAN_CHUNK = 1024 * 1024;
/** What Remote Control's `bridge_status` entry links to (REQ-003-43); anything else is no link. */
const CHAT_URL = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/;
/** Tool inputs that make a short argument, in order of preference; file paths are made relative to the session. */
const TOOL_ARGS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "skill", "description"];
const PATH_ARGS = new Set(["file_path", "notebook_path", "path"]);

export interface TranscriptStep {
  kind: "thinking" | "tool" | "says";
  text: string;
  /** The entry's timestamp (ISO). */
  at: string;
}

export interface TranscriptTail {
  /** The latest agent step in the tail. */
  step?: TranscriptStep;
  /** The latest text the agent wrote in the tail, for an ended turn. */
  lastText?: TranscriptStep;
  /** The session's Remote Control URL (REQ-003-43). */
  chatUrl?: string;
}

type Entry = {
  type?: unknown;
  subtype?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  isApiErrorMessage?: unknown;
  isSidechain?: unknown;
  url?: unknown;
  content?: unknown;
  message?: { content?: unknown };
};

const parse = (line: string): Entry | undefined => {
  if (!line.trim()) return undefined;
  try {
    const v = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Entry) : undefined;
  } catch {
    return undefined;
  }
};

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
};

const toolText = (block: Record<string, unknown>, cwd: unknown): string => {
  const name = typeof block.name === "string" ? block.name : "tool";
  const input = typeof block.input === "object" && block.input !== null ? (block.input as Record<string, unknown>) : {};
  for (const key of TOOL_ARGS) {
    let arg = input[key];
    if (typeof arg !== "string" || !arg.trim()) continue;
    if (PATH_ARGS.has(key) && typeof cwd === "string" && arg.startsWith(`${cwd}/`)) arg = arg.slice(cwd.length + 1);
    return oneLine(`${name} · ${arg}`);
  }
  return name;
};

/** The step one content block stands for; undefined for blocks the Now line doesn't know. */
const blockStep = (block: unknown, entry: Entry, at: string): TranscriptStep | undefined => {
  if (typeof block !== "object" || block === null) return undefined;
  const b = block as Record<string, unknown>;
  if (b.type === "thinking") return { kind: "thinking", text: oneLine(String(b.thinking ?? "")), at };
  if (b.type === "tool_use") return { kind: "tool", text: toolText(b, entry.cwd), at };
  if (b.type === "text" && typeof b.text === "string" && b.text.trim())
    return { kind: "says", text: oneLine(b.text), at };
  return undefined;
};

/** The latest step and the latest text among the given transcript lines (oldest first). */
export function tailSteps(lines: string[]): Pick<TranscriptTail, "step" | "lastText"> {
  const out: Pick<TranscriptTail, "step" | "lastText"> = {};
  for (let i = lines.length - 1; i >= 0 && !(out.step && out.lastText); i--) {
    const entry = parse(lines[i] ?? "");
    if (entry?.type !== "assistant" || entry.isApiErrorMessage === true || entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content) || typeof entry.timestamp !== "string") continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const step = blockStep(content[j], entry, entry.timestamp);
      if (!step) continue;
      out.step ??= step;
      if (step.kind === "says") out.lastText ??= step;
      if (out.lastText) break;
    }
  }
  return out;
}

/** The Remote Control URL of a `bridge_status` entry, if the line is one with a claude.ai session URL. */
const chatUrlOf = (line: string): string | undefined => {
  if (!line.includes('"bridge_status"')) return undefined;
  const entry = parse(line);
  if (entry?.type !== "system" || entry.subtype !== "bridge_status") return undefined;
  const url = typeof entry.url === "string" ? entry.url : undefined;
  return url && CHAT_URL.test(url) ? url : undefined;
};

/**
 * Reads transcripts for the dashboard. The tail is read on every call; the scan for the Remote Control URL,
 * which Claude Code writes near the start, remembers how far it got per transcript and reads only what was
 * appended since (REQ-003-43).
 */
export class TranscriptReader {
  private scans = new Map<string, { to: number; url?: string }>();

  /** Undefined when the path isn't a readable `.jsonl` file. Never throws. */
  read(path: string): TranscriptTail | undefined {
    if (!path.endsWith(".jsonl")) return undefined;
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = statSync(path).size;
      const chatUrl = this.scan(fd, path, size);
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      // The tail's first line is cut off unless the tail is the whole file.
      if (start > 0) lines.shift();
      return { ...tailSteps(lines), ...(chatUrl && { chatUrl }) };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Bytes of the transcript scanned for the URL so far; 0 before the first read. */
  scannedTo(path: string): number {
    return this.scans.get(path)?.to ?? 0;
  }

  private scan(fd: number, path: string, size: number): string | undefined {
    let state = this.scans.get(path);
    // A transcript that got shorter was replaced: scan it again.
    if (!state || state.to > size) state = { to: 0 };
    let pending = Buffer.alloc(0);
    let pos = state.to;
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(SCAN_CHUNK, size - pos));
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = Buffer.concat([pending, chunk.subarray(0, n)]);
      const end = data.lastIndexOf(0x0a);
      if (end < 0) {
        pending = data;
        continue;
      }
      for (const line of data.subarray(0, end).toString("utf8").split("\n")) state.url = chatUrlOf(line) ?? state.url;
      pending = data.subarray(end + 1);
    }
    // An unfinished last line is scanned again once it is complete.
    state.to = pos - pending.length;
    this.scans.set(path, state);
    return state.url;
  }
}
