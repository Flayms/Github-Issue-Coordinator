/**
 * Recording Events (REQ-003-15): what the Coordinator did on GitHub, for the dashboard's Recent column.
 * Recording is best effort: a store error is logged and never fails the tick or the GitHub action.
 */
import type { CoordinatorEvent, Store } from "./store.ts";

/** Failure reasons can be long (a whole error); the Recent column shows a short sentence. */
const TEXT_LIMIT = 300;

export type Log = (message: string) => void;

export const defaultLog: Log = (m) => console.log(`${new Date().toISOString()} ${m}`);

/** `#5, #6` */
export const refs = (numbers: number[]): string => numbers.map((n) => `#${n}`).join(", ");

export function recordEvent(store: Pick<Store, "recordEvent">, log: Log, e: Omit<CoordinatorEvent, "at">): void {
  const text = e.text.length > TEXT_LIMIT ? `${e.text.slice(0, TEXT_LIMIT - 1)}…` : e.text;
  try {
    store.recordEvent({ ...e, text });
  } catch (err) {
    log(`${e.repo}: could not record an Event (${text}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
