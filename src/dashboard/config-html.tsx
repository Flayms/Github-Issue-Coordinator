/**
 * The Config page (REQ-003-05): the effective settings as React components rendered on the server
 * (REQ-003-19). It renders only the allow-listed `SettingsView` and the editable fields, so no secret
 * reaches it. For the signed-in Owner the editable settings are a form (REQ-003-36).
 */
import type { ReactNode } from "react";
import { EFFORTS, isLoopback, ROLES } from "../config.ts";
import { ROLE_NAMES } from "../note.ts";
import type { SettingField, SettingsForm } from "./settings-form.ts";
import { Count, Empty, Footer, Icon, Label, Layout, plural, renderPage } from "./ui.tsx";
import type { DashboardView, RoleView, SettingsView } from "./view.ts";

const Fact = ({ ok, children }: { ok: boolean; children: string }) => (
  <li className={`inline-flex items-center gap-1.5 ${ok ? "text-ok" : "text-warn"}`}>
    <Icon name={ok ? "check" : "alert"} />
    {children}
  </li>
);

const SIGN_IN = {
  on: "GitHub sign-in, Owner only",
  off: "No GitHub sign-in",
  "not set up": "GitHub sign-in not set up",
} as const;

function Access({ s }: { s: SettingsView }) {
  const a = s.access;
  if (!a) return null;
  const loopback = isLoopback(a.host);
  return (
    <section id="access" className="mt-10">
      <Label>Access</Label>
      <ol className="hops flex flex-wrap items-center gap-2.5 [&>li]:inline-flex [&>li]:items-center [&>li]:gap-2 [&_svg]:text-acc-hi">
        <li>
          <Icon name="phone" />
          <span>Your browser</span>
        </li>
        <li>
          <Icon name="shield" />
          <span>{loopback ? "Tailscale or an SSH tunnel" : "Your network"}</span>
        </li>
        <li>
          <Icon name="server" />
          <span>
            Coordinator at{" "}
            <code className="font-mono">
              {a.host}:{a.port}
            </code>
          </span>
        </li>
      </ol>
      <ul className="mt-4 flex flex-wrap gap-x-[22px] gap-y-2 text-[13px]">
        <Fact ok={a.githubLogin === "on"}>{SIGN_IN[a.githubLogin]}</Fact>
        <Fact ok={a.tokenRequired || a.githubLogin === "on"}>{a.tokenRequired ? "Token required" : "No token"}</Fact>
        <Fact ok>{a.githubLogin === "on" ? "GET only, besides Sign out and saving settings" : "GET only"}</Fact>
        <Fact ok={loopback}>{loopback ? "Loopback only" : `Listens on ${a.host}`}</Fact>
        <Fact ok>{a.githubLogin === "on" ? "Only the sign-in calls GitHub" : "No GitHub calls"}</Fact>
      </ul>
    </section>
  );
}

function Limits({ s }: { s: SettingsView }) {
  const all: [string, number][] = [...Object.entries(s.limits), ["checksGraceSeconds", s.checksGraceSeconds]];
  return (
    <section id="limits" className="mt-10">
      <Label>Limits</Label>
      <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-5">
        {all.map(([k, v]) => (
          <div key={k} className="border-line border-t py-3.5">
            <dd className="font-bold font-display text-[34px] leading-none tracking-[-0.02em]">{v}</dd>
            <dt className="mt-1.5 font-mono text-[11px] text-muted wrap-anywhere">{k}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

const cell = "border-line border-t py-2.5 pr-3 text-left align-top";

const RoleRow = ({ r, where }: { r: RoleView; where?: string }) => (
  <tr>
    <th scope="row" className={`${cell} ${where ? "font-medium" : "font-semibold"}`}>
      {r.role}
      {where && <span className="text-muted"> in {where}</span>}
    </th>
    <td className={`${cell} font-mono text-[0.86em]`}>{r.model}</td>
    <td className={cell}>{r.effort ?? "default"}</td>
  </tr>
);

function Models({ s }: { s: SettingsView }) {
  const head = "pt-2.5 pr-3 pb-2.5 text-left font-medium text-[11px] text-faint uppercase tracking-widest";
  return (
    <section id="models">
      <Label>Models</Label>
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr>
            <th scope="col" className={head}>
              Role
            </th>
            <th scope="col" className={head}>
              Model
            </th>
            <th scope="col" className={head}>
              Effort
            </th>
          </tr>
        </thead>
        <tbody>
          {s.roles.map((r) => (
            <RoleRow key={r.role} r={r} />
          ))}
          {s.repos.flatMap((repo) =>
            repo.overrides.map((r) => <RoleRow key={`${repo.name} ${r.role}`} r={r} where={repo.name} />),
          )}
        </tbody>
      </table>
    </section>
  );
}

function Repo({ r }: { r: SettingsView["repos"][number] }) {
  const c = r.counts;
  return (
    <li className="grid gap-2 border-line border-t py-3.5 first:border-t-0">
      <div className="flex items-center gap-2 text-[16px]">
        <Icon name="repo" className="size-4 text-acc-hi" />
        <span className="font-mono text-[0.86em]">{r.name}</span>
      </div>
      {c ? (
        <ul className="flex flex-wrap gap-x-[18px] gap-y-1 text-[13px] text-muted [&_b]:font-display [&_b]:text-fg">
          <li>
            <b>{c.issues}</b> {c.issues === 1 ? "open issue" : "open issues"}
          </li>
          <li>
            <b>{c.pulls}</b> {c.pulls === 1 ? "agent PR" : "agent PRs"}
          </li>
          <li>
            <b>{c.worktrees}</b> {c.worktrees === 1 ? "Worktree" : "Worktrees"}
          </li>
        </ul>
      ) : (
        <p className="text-muted">No tick yet.</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-[13px]">
        <dt className="text-faint">Setup</dt>
        <dd className="min-w-0 wrap-anywhere">{r.setup ? <code className="font-mono">{r.setup}</code> : "–"}</dd>
        <dt className="text-faint">Auto-merge</dt>
        <dd className="min-w-0">
          <code className="font-mono">{r.autoMerge}</code>
        </dd>
      </dl>
    </li>
  );
}

function Repos({ s }: { s: SettingsView }) {
  return (
    <section id="repos">
      <Label>
        Repositories <Count>{s.repos.length}</Count>
      </Label>
      {s.repos.length ? (
        <ul>
          {s.repos.map((r) => (
            <Repo key={r.name} r={r} />
          ))}
        </ul>
      ) : (
        <Empty>No repositories configured.</Empty>
      )}
    </section>
  );
}

const input =
  "w-full min-w-0 rounded-md border border-line-2 bg-white/4 px-2.5 py-1.5 text-fg focus:border-acc focus:outline-none";
const button =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] hover:border-acc hover:text-fg";

/** REQ-003-36: a changed field names config.ts's value and can go back to it. */
function Changed({ f, empty }: { f: SettingField; empty: string }) {
  if (!f.changed) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-acc-hi">
      <span>{`config.ts: ${f.base || empty}`}</span>
      <button
        type="submit"
        name="reset"
        value={f.name}
        formNoValidate
        className="cursor-pointer text-muted underline hover:text-fg"
      >
        Reset
      </button>
    </span>
  );
}

const fieldId = (name: string) => `f-${name}`;

function NumberField({ f }: { f: SettingField }) {
  const label = f.name.replace(/^limits\./, "");
  return (
    <div className="border-line border-t py-3.5">
      <label htmlFor={fieldId(f.name)} className="block font-mono text-[11px] text-muted wrap-anywhere">
        {label}
      </label>
      <input
        id={fieldId(f.name)}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        required
        name={f.name}
        defaultValue={f.value}
        className={`${input} mt-1.5 font-bold font-display text-[22px]`}
      />
      <Changed f={f} empty="–" />
    </div>
  );
}

function ModelField({ f, label, inherit }: { f: SettingField; label: string; inherit?: string }) {
  return (
    <>
      <input
        id={fieldId(f.name)}
        type="text"
        aria-label={label}
        name={f.name}
        defaultValue={f.value}
        placeholder={inherit}
        required={inherit === undefined}
        autoComplete="off"
        spellCheck={false}
        className={`${input} font-mono text-[0.86em] placeholder:text-faint placeholder:italic`}
      />
      <Changed f={f} empty={inherit ? "the global model" : "–"} />
    </>
  );
}

function EffortField({ f, label, inherit }: { f: SettingField; label: string; inherit?: string }) {
  return (
    <>
      <select
        id={fieldId(f.name)}
        aria-label={label}
        name={f.name}
        defaultValue={f.value}
        className={`${input} w-auto`}
      >
        <option value="">{inherit === undefined ? "default" : `global (${inherit})`}</option>
        {EFFORTS.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
      <Changed f={f} empty={inherit === undefined ? "default" : "the global effort"} />
    </>
  );
}

function EditLimits({ form }: { form: SettingsForm }) {
  return (
    <section id="limits" className="mt-10">
      <Label>Limits</Label>
      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-5">
        {form.fields
          .filter((f) => f.kind === "number")
          .map((f) => (
            <NumberField key={f.name} f={f} />
          ))}
      </div>
    </section>
  );
}

/** The model and effort fields of the three Roles, globally (`prefix` `roles`) or in a repository. */
function RoleRows({ form, prefix, where }: { form: SettingsForm; prefix: string; where?: string }) {
  const get = (name: string) => form.fields.find((f) => f.name === name);
  return ROLES.map((role) => {
    const model = get(`${prefix}.${role}.model`);
    const effort = get(`${prefix}.${role}.effort`);
    if (!model || !effort) return null;
    const global = where ? get(`roles.${role}.model`)?.value : undefined;
    const globalEffort = where ? get(`roles.${role}.effort`)?.value || "default" : undefined;
    const name = `${ROLE_NAMES[role]}${where ? ` in ${where}` : ""}`;
    return (
      <tr key={role}>
        <th scope="row" className={`${cell} font-semibold`}>
          {ROLE_NAMES[role]}
        </th>
        <td className={cell}>
          <ModelField f={model} label={`${name}: model`} inherit={where ? global : undefined} />
        </td>
        <td className={cell}>
          <EffortField f={effort} label={`${name}: effort`} inherit={globalEffort} />
        </td>
      </tr>
    );
  });
}

function EditModels({ form, s }: { form: SettingsForm; s: SettingsView }) {
  const head = "pt-2.5 pr-3 pb-2.5 text-left font-medium text-[11px] text-faint uppercase tracking-widest";
  const table = (rows: ReactNode) => (
    <table className="w-full border-collapse text-[14px]">
      <thead>
        <tr>
          <th scope="col" className={head}>
            Role
          </th>
          <th scope="col" className={head}>
            Model
          </th>
          <th scope="col" className={head}>
            Effort
          </th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
  return (
    <section id="models">
      <Label>Models</Label>
      {table(<RoleRows form={form} prefix="roles" />)}
      {s.repos.map((r) => {
        const prefix = `repos.${r.name}.roles`;
        const set = form.fields.some((f) => f.name.startsWith(`${prefix}.`) && (f.value || f.changed));
        return (
          <details key={r.name} open={set} className="mt-4 border-line border-t pt-3">
            <summary className="cursor-pointer text-[14px] text-muted">
              In <span className="font-mono text-[0.86em] text-fg">{r.name}</span>
              {set ? "" : " (as above)"}
            </summary>
            {table(<RoleRows form={form} prefix={prefix} where={r.name} />)}
          </details>
        );
      })}
    </section>
  );
}

function Notice({ form }: { form: SettingsForm }) {
  if (form.errors.length)
    return (
      <div role="alert" className="mt-6 rounded-md border border-bad/50 px-4 py-3 text-[14px]">
        <p className="flex items-center gap-2 font-semibold text-bad">
          <Icon name="alert" />
          Nothing was saved:
        </p>
        <ul className="mt-1.5 list-disc pl-6 font-mono text-[12px] text-muted">
          {form.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    );
  if (form.saved)
    return (
      <p role="status" className="mt-6 flex items-center gap-2 text-[14px] text-ok">
        <Icon name="check" />
        Saved. The Coordinator uses the new settings from its next tick on.
      </p>
    );
  return null;
}

const SaveButton = () => (
  <button type="submit" className={`${button} border-acc bg-acc/20 text-fg`}>
    <Icon name="check" />
    Save
  </button>
);

/** REQ-003-36: the editable settings as one plain form, so it works without JavaScript. */
function EditForm({ form, s }: { form: SettingsForm; s: SettingsView }) {
  return (
    <form method="post" action="/config" id="settings" className="mt-10">
      <input type="hidden" name="formToken" value={form.token} />
      {/* The first submit button, so Enter in a field saves instead of resetting one. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
        <SaveButton />
        <span>Applies from the next tick on; running sessions keep going. Changes are kept in the state dir.</span>
      </div>
      <Notice form={form} />
      <EditLimits form={form} />
      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <EditModels form={form} s={s} />
        <Repos s={s} />
      </div>
      <div className="mt-8">
        <SaveButton />
      </div>
    </form>
  );
}

export function ConfigPage({ v, form }: { v: DashboardView; form?: SettingsForm }) {
  const s = v.settings;
  return (
    <Layout v={v} page="config" editing={form !== undefined}>
      <main className="wrap">
        <section className="mt-10 pt-3">
          <p className="mb-2.5 font-mono font-semibold text-[12px] text-acc-hi uppercase leading-none tracking-[0.16em]">
            Config
          </p>
          <h1 className="font-extrabold text-[clamp(40px,6vw,60px)] text-white leading-[1.02] tracking-[-0.03em]">
            Polling {plural(s.repos.length, "repository", "repositories")} every {s.pollIntervalSec} s
          </h1>
          <p className="mt-3.5 max-w-[60ch] text-muted">
            {form
              ? "The effective settings: the config file with your changes from here. Repositories, Accounts and access stay in the config file. No secrets: keys and tokens are never shown."
              : "The effective settings. Read-only, and no secrets: keys and tokens are never shown."}
          </p>
        </section>
        <Access s={s} />
        {form ? (
          <EditForm form={form} s={s} />
        ) : (
          <>
            <Limits s={s} />
            <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <Models s={s} />
              <Repos s={s} />
            </div>
          </>
        )}
      </main>
      <Footer editing={form !== undefined} />
    </Layout>
  );
}

export const renderConfig = (v: DashboardView, form?: SettingsForm): string =>
  renderPage(<ConfigPage v={v} form={form} />);
