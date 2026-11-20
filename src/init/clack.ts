/** The terminal Prompter (REQ-007-08), with `@clack/prompts`. */
import * as p from "@clack/prompts";
import { Cancelled, type Prompter } from "./prompter.ts";

/** A cancelled question throws, so `init` writes nothing. */
function answered<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) throw new Cancelled();
  return v as Exclude<T, symbol>;
}

/** The multi-select gets a search field above this many choices. */
const SEARCH_FROM = 10;

export const clackPrompter = (): Prompter => ({
  intro: (title) => p.intro(title),
  note: (message, title) => p.note(message, title),
  info: (message) => p.log.info(message),
  outro: (message) => p.outro(message),
  text: async (o) =>
    answered(
      await p.text({
        message: o.message,
        initialValue: o.initial,
        placeholder: o.placeholder,
        validate: o.validate && ((v) => o.validate?.(v ?? "")),
      }),
    ),
  password: async (o) =>
    answered(await p.password({ message: o.message, validate: o.validate && ((v) => o.validate?.(v ?? "")) })),
  confirm: async (o) => answered(await p.confirm({ message: o.message, initialValue: o.initial })),
  select: async (o) =>
    answered(
      await p.select({
        message: o.message,
        // biome-ignore lint/suspicious/noExplicitAny: clack's Option type is a conditional type TS can't narrow here.
        options: o.options as any,
        initialValue: o.initial,
      }),
    ),
  multiselect: async (o) =>
    answered(
      o.options.length > SEARCH_FROM
        ? await p.autocompleteMultiselect({
            message: o.message,
            // biome-ignore lint/suspicious/noExplicitAny: as above.
            options: o.options as any,
            initialValues: o.initial,
            required: true,
            placeholder: "Type to search",
          })
        : await p.multiselect({
            message: o.message,
            // biome-ignore lint/suspicious/noExplicitAny: as above.
            options: o.options as any,
            initialValues: o.initial,
            required: true,
          }),
    ),
});
