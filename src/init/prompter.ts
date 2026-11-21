/**
 * How `issueflow init` asks (REQ-007-08): a small interface of its own, so tests answer from a script without a
 * terminal. `src/init/clack.ts` asks in the terminal.
 */

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  intro(title: string): void;
  /** A block of text worth reading before the next question, e.g. what to register in a GitHub OAuth App. */
  note(message: string, title?: string): void;
  info(message: string): void;
  outro(message: string): void;
  /** `validate` returns the error to show, or undefined when the value is fine. */
  text(o: {
    message: string;
    initial?: string;
    placeholder?: string;
    validate?: (v: string) => string | undefined;
  }): Promise<string>;
  /** Hidden input, for a token or a secret. */
  password(o: { message: string; validate?: (v: string) => string | undefined }): Promise<string>;
  confirm(o: { message: string; initial?: boolean }): Promise<boolean>;
  select<T extends string>(o: { message: string; options: Choice<T>[]; initial?: T }): Promise<T>;
  /** Searchable when the list is long. */
  multiselect<T extends string>(o: { message: string; options: Choice<T>[]; initial?: T[] }): Promise<T[]>;
}

/** The Owner pressed Ctrl-C (or Escape): `init` stops and writes nothing. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}
