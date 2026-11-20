/**
 * The Config page's form (REQ-007-05, Extra instructions REQ-003-44): one field per editable setting, and the change
 * to the config file a submitted form makes. Only these fields exist, so nothing else can be set from the dashboard.
 */

import {
  type AutoMergeMode,
  type Config,
  ConfigError,
  type Effort,
  EXTRA_INSTRUCTIONS_LIMIT,
  LIMIT_KEYS,
  ROLES,
  type Role,
} from "../config.ts";
import type { SettingsChange, SettingsEditor } from "../config-file.ts";
import type { HarnessName } from "../harness/harness.ts";
import { inCatalogue } from "../models.ts";

export type FieldKind = "number" | "model" | "effort" | "autoMerge" | "instructions";

/** A form field; values are the form's strings, `""` for an effort or a repository's model or auto-merge mode means "not set". */
export interface SettingField {
  /** The field's `name` in the form, e.g. `limits.maxRunning` or `repos.octo/app.roles.planner.model`. */
  name: string;
  kind: FieldKind;
  /** The value shown: the one in use, or what the Owner entered when saving failed. */
  value: string;
  /** The value in use, before the Owner's input. */
  current: string;
  /** Sets `value` (different from `current`) in `o`; returns an error, or undefined. */
  set: (o: SettingsChange, value: string) => string | undefined;
}

/** What the Config page needs for the form; absent for a token or no sign-in, so the page stays read-only. */
export interface SettingsForm {
  token: string;
  fields: SettingField[];
  /** Why saving failed; nothing was saved. */
  errors: string[];
  saved: boolean;
  /** The models the sessions reported, so an alias's option says what it means now (REQ-003-40). */
  reportedModels: string[];
  /** REQ-006-01: the Harnesses that have an Account, whose models the dropdown offers; absent: Claude Code's. */
  harnesses?: HarnessName[];
}

const whole = (v: string): number | undefined => (/^\s*\d+\s*$/.test(v) ? Number(v) : undefined);

function numberField(
  name: string,
  get: (c: Config) => number,
  put: (o: SettingsChange, n: number) => void,
  config: Config,
): SettingField {
  const v = String(get(config));
  return {
    name,
    kind: "number",
    value: v,
    current: v,
    set: (o, value) => {
      const n = whole(value);
      if (n === undefined) return `${name}: must be a whole number`;
      put(o, n);
    },
  };
}

function textField(
  name: string,
  kind: "model" | "effort" | "autoMerge",
  get: (c: Config) => string | undefined,
  put: (o: SettingsChange, v: string | null) => void,
  config: Config,
  required: boolean,
): SettingField {
  const v = get(config) ?? "";
  return {
    name,
    kind,
    value: v,
    current: v,
    set: (o, value) => {
      const t = value.trim();
      if (!t && required) return `${name}: needs a ${kind === "model" ? "model" : "value"}`;
      // REQ-003-40: a model from the list, or the one the field already has in the config file.
      if (kind === "model" && t && !inCatalogue(t) && t !== v) return `${name}: must be a model from the list`;
      put(o, t || null);
    },
  };
}

/** REQ-003-44: a Role's Extra instructions; empty removes them from the file. */
function instructionsField(
  name: string,
  get: (c: Config) => string | undefined,
  put: (o: SettingsChange, v: string | null) => void,
  config: Config,
): SettingField {
  const v = get(config) ?? "";
  return {
    name,
    kind: "instructions",
    value: v,
    current: v,
    set: (o, value) => {
      if (value.length > EXTRA_INSTRUCTIONS_LIMIT)
        return `${name}: must be at most ${EXTRA_INSTRUCTIONS_LIMIT.toLocaleString("en")} characters`;
      put(o, value || null);
    },
  };
}

const globalRole = (o: SettingsChange, role: Role) => {
  o.roles ??= {};
  o.roles[role] ??= {};
  return o.roles[role];
};

const repoEntry = (o: SettingsChange, repo: string) => {
  o.repos ??= {};
  o.repos[repo] ??= {};
  return o.repos[repo];
};

const repoRole = (o: SettingsChange, repo: string, role: Role) => {
  const r = repoEntry(o, repo);
  r.roles ??= {};
  r.roles[role] ??= {};
  return r.roles[role];
};

const repoOf = (c: Config, name: string) => c.repos.find((r) => r.name === name);

/**
 * The editable settings, in the page's order: top-level, limits, Roles, Extra instructions, then each repository's
 * auto-merge mode, Roles and Extra instructions.
 */
export function settingFields(config: Config): SettingField[] {
  const fields: SettingField[] = [
    numberField(
      "pollIntervalSec",
      (c) => c.pollIntervalSec,
      (o, n) => {
        o.pollIntervalSec = n;
      },
      config,
    ),
    numberField(
      "checksGraceSeconds",
      (c) => c.checksGraceSeconds,
      (o, n) => {
        o.checksGraceSeconds = n;
      },
      config,
    ),
  ];
  fields.push(
    textField(
      "autoMerge",
      "autoMerge",
      (c) => c.autoMerge,
      (o, v) => {
        if (v) o.autoMerge = v as AutoMergeMode;
      },
      config,
      true,
    ),
  );
  for (const k of LIMIT_KEYS)
    fields.push(
      numberField(
        `limits.${k}`,
        (c) => c.limits[k],
        (o, n) => {
          o.limits = { ...o.limits, [k]: n };
        },
        config,
      ),
    );
  for (const role of ROLES) {
    fields.push(
      textField(
        `roles.${role}.model`,
        "model",
        (c) => c.roles[role].model,
        (o, v) => {
          if (v) globalRole(o, role).model = v;
        },
        config,
        true,
      ),
      textField(
        `roles.${role}.effort`,
        "effort",
        (c) => c.roles[role].effort,
        (o, v) => {
          globalRole(o, role).effort = v as Effort | null;
        },
        config,
        false,
      ),
    );
  }
  for (const role of ROLES)
    fields.push(
      instructionsField(
        `instructions.${role}`,
        (c) => c.instructions?.[role],
        (o, v) => {
          o.instructions = { ...o.instructions, [role]: v };
        },
        config,
      ),
    );
  for (const { name } of config.repos) {
    fields.push(
      textField(
        `repos.${name}.autoMerge`,
        "autoMerge",
        (c) => repoOf(c, name)?.autoMerge,
        (o, v) => {
          repoEntry(o, name).autoMerge = v as AutoMergeMode | null;
        },
        config,
        false,
      ),
    );
    for (const role of ROLES) {
      const prefix = `repos.${name}.roles.${role}`;
      fields.push(
        textField(
          `${prefix}.model`,
          "model",
          (c) => repoOf(c, name)?.roles?.[role]?.model,
          (o, v) => {
            repoRole(o, name, role).model = v;
          },
          config,
          false,
        ),
        textField(
          `${prefix}.effort`,
          "effort",
          (c) => repoOf(c, name)?.roles?.[role]?.effort,
          (o, v) => {
            repoRole(o, name, role).effort = v as Effort | null;
          },
          config,
          false,
        ),
      );
    }
    for (const role of ROLES)
      fields.push(
        instructionsField(
          `repos.${name}.instructions.${role}`,
          (c) => repoOf(c, name)?.instructions?.[role],
          (o, v) => {
            const r = repoEntry(o, name);
            r.instructions = { ...r.instructions, [role]: v };
          },
          config,
        ),
      );
  }
  return fields;
}

/**
 * The change a submitted form makes: each field whose value differs from the one in use. `value` gives the submitted
 * value of a field, undefined when it wasn't sent (the field keeps its value).
 */
export function changeFrom(fields: SettingField[], value: (name: string) => string | undefined): SettingsChange {
  const o: SettingsChange = {};
  const errors: string[] = [];
  for (const f of fields) {
    const v = value(f.name) ?? f.current;
    if (v === f.current) continue;
    const error = f.set(o, v);
    if (error) errors.push(error);
  }
  if (errors.length) throw new ConfigError(errors, "settings");
  return o;
}

/** Saves a submitted form into the config file (REQ-007-05). Returns the errors; empty when saved. */
export function saveSettings(
  editor: SettingsEditor,
  form: { get(name: string): unknown },
): { errors: string[]; fields: SettingField[] } {
  const fields = settingFields(editor.current);
  // A textarea sends line breaks as CRLF (REQ-003-44); they are kept as LF, like the file's text.
  const submitted = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v.replace(/\r\n?/g, "\n") : undefined;
  };
  try {
    editor.save(changeFrom(fields, submitted));
    return { errors: [], fields };
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return {
      errors: e.issues,
      fields: fields.map((f) => {
        const v = submitted(f.name);
        return v === undefined ? f : { ...f, value: v };
      }),
    };
  }
}
