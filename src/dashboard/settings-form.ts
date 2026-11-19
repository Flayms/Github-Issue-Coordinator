/**
 * The Config page's form (REQ-003-36): one field per editable setting, and the Settings overrides a
 * submitted form makes. Only these fields exist, so nothing else can be set from the dashboard.
 */
import { type AutoMergeMode, type Config, ConfigError, type Effort, LIMIT_KEYS, ROLES, type Role } from "../config.ts";
import { inCatalogue } from "../models.ts";
import type { Overrides, SettingsEditor } from "../overrides.ts";

export type FieldKind = "number" | "model" | "effort" | "autoMerge";

/** A form field; values are the form's strings, `""` for an effort or a repository's model or auto-merge mode means "not set". */
export interface SettingField {
  /** The field's `name` in the form, e.g. `limits.maxRunning` or `repos.octo/app.roles.planner.model`. */
  name: string;
  kind: FieldKind;
  /** The value shown: the effective one, or what the Owner entered when saving failed. */
  value: string;
  /** `config.ts`'s value. */
  base: string;
  /** The effective value differs from `config.ts`'s. */
  changed: boolean;
  /** Sets `value` (different from `base`) in `o`; returns an error, or undefined. */
  set: (o: Overrides, value: string) => string | undefined;
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
}

const whole = (v: string): number | undefined => (/^\s*\d+\s*$/.test(v) ? Number(v) : undefined);

function numberField(
  name: string,
  get: (c: Config) => number,
  put: (o: Overrides, n: number) => void,
  base: Config,
  current: Config,
): SettingField {
  const b = String(get(base));
  const v = String(get(current));
  return {
    name,
    kind: "number",
    value: v,
    base: b,
    changed: v !== b,
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
  put: (o: Overrides, v: string | null) => void,
  base: Config,
  current: Config,
  required: boolean,
): SettingField {
  const b = get(base) ?? "";
  const v = get(current) ?? "";
  return {
    name,
    kind,
    value: v,
    base: b,
    changed: v !== b,
    set: (o, value) => {
      const t = value.trim();
      if (!t && required) return `${name}: needs a ${kind === "model" ? "model" : "value"}`;
      // REQ-003-40: a model from the list, or the one the field already has (config.ts's or a saved one).
      if (kind === "model" && t && !inCatalogue(t) && t !== b && t !== v)
        return `${name}: must be a model from the list`;
      put(o, t || null);
    },
  };
}

const globalRole = (o: Overrides, role: Role) => {
  o.roles ??= {};
  o.roles[role] ??= {};
  return o.roles[role];
};

const repoEntry = (o: Overrides, repo: string) => {
  o.repos ??= {};
  o.repos[repo] ??= {};
  return o.repos[repo];
};

const repoRole = (o: Overrides, repo: string, role: Role) => {
  const r = repoEntry(o, repo);
  r.roles ??= {};
  r.roles[role] ??= {};
  return r.roles[role];
};

const repoOf = (c: Config, name: string) => c.repos.find((r) => r.name === name);

/** The editable settings, in the page's order: top-level, limits, Roles, then each repository's Roles. */
export function settingFields(base: Config, current: Config): SettingField[] {
  const fields: SettingField[] = [
    numberField(
      "pollIntervalSec",
      (c) => c.pollIntervalSec,
      (o, n) => {
        o.pollIntervalSec = n;
      },
      base,
      current,
    ),
    numberField(
      "checksGraceSeconds",
      (c) => c.checksGraceSeconds,
      (o, n) => {
        o.checksGraceSeconds = n;
      },
      base,
      current,
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
      base,
      current,
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
        base,
        current,
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
        base,
        current,
        true,
      ),
      textField(
        `roles.${role}.effort`,
        "effort",
        (c) => c.roles[role].effort,
        (o, v) => {
          globalRole(o, role).effort = v as Effort | null;
        },
        base,
        current,
        false,
      ),
    );
  }
  for (const { name } of base.repos) {
    fields.push(
      textField(
        `repos.${name}.autoMerge`,
        "autoMerge",
        (c) => repoOf(c, name)?.autoMerge,
        (o, v) => {
          repoEntry(o, name).autoMerge = v as AutoMergeMode | null;
        },
        base,
        current,
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
          base,
          current,
          false,
        ),
        textField(
          `${prefix}.effort`,
          "effort",
          (c) => repoOf(c, name)?.roles?.[role]?.effort,
          (o, v) => {
            repoRole(o, name, role).effort = v as Effort | null;
          },
          base,
          current,
          false,
        ),
      );
    }
  }
  return fields;
}

/**
 * The overrides a submitted form makes: each field whose value differs from `config.ts`'s. `value` gives the
 * submitted value of a field, undefined when it wasn't sent (the field keeps its effective value).
 */
export function overridesFrom(fields: SettingField[], value: (name: string) => string | undefined): Overrides {
  const o: Overrides = {};
  const errors: string[] = [];
  for (const f of fields) {
    const v = value(f.name) ?? f.value;
    if (v === f.base) continue;
    const error = f.set(o, v);
    if (error) errors.push(error);
  }
  if (errors.length) throw new ConfigError(errors, "settings");
  return o;
}

/**
 * Saves a submitted form (REQ-003-36). With `reset`, only that field goes back to `config.ts` and the other
 * saved overrides stay; the other submitted values are dropped. Returns the errors; empty when saved.
 */
export function saveSettings(
  editor: SettingsEditor,
  form: { get(name: string): unknown },
): { errors: string[]; fields: SettingField[] } {
  const fields = settingFields(editor.base, editor.current);
  const reset = form.get("reset");
  const submitted = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const value =
    typeof reset === "string"
      ? (name: string) => (name === reset ? fields.find((f) => f.name === name)?.base : undefined)
      : submitted;
  try {
    editor.save(overridesFrom(fields, value));
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
