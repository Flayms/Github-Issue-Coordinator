/**
 * `issueflow init` (REQ-007-08 to REQ-007-10): asks the Owner a few questions, writes the config file and the secret
 * files, runs the setup check and offers to install the service. Everything outside goes through `InitEnv`, every
 * question through the `Prompter`, so tests run it without a terminal, `gh` or systemd.
 */
import { dirname, join, resolve } from "node:path";
import { harnessOfAccount } from "../accounts.ts";
import { type AutoMergeMode, ConfigError, EFFORTS, parseConfig, ROLES, type Role } from "../config.ts";
import { HARNESS_NAMES, HARNESSES, type HarnessName } from "../harness/index.ts";
import { HARNESS_MODELS, harnessOfModel, modelLabel } from "../models.ts";
import { Cancelled, type Choice, type Prompter } from "./prompter.ts";

/** The world outside the questions. */
export interface InitEnv {
  /** `gh auth status` succeeds. */
  ghLoggedIn(): boolean;
  /** `gh auth login --with-token`, the token on stdin. */
  ghLogin(token: string): { ok: boolean; out: string };
  /** `gh api user`, or `gh api users/<login>`. */
  ghUser(login?: string): Promise<{ login: string; id: number }>;
  /** The repositories the token can push to, as `owner/repo`. */
  ghRepos(): Promise<string[]>;
  /** The names in a repository's root folder, to guess its `setup` command. */
  rootFiles(repo: string): Promise<string[]>;
  readFile(path: string): string | undefined;
  /** Creates the folder first; `mode` 0o600 for a secret. */
  writeFile(path: string, text: string, mode?: number): void;
  /** A new random token for the dashboard. */
  randomToken(): string;
  /** The CLI is on the PATH, e.g. `codex`; to preselect the Harnesses installed. */
  onPath(bin: string): boolean;
  doctor(configPath: string): Promise<number>;
  serviceInstall(configPath: string): Promise<number>;
  /** The `$schema` the config gets: the installed `config.schema.json`. */
  schemaUrl: string;
  home: string;
  /** The state folder when the config sets none (REQ-007-03). */
  defaultStateDir: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The defaults `init` preselects for a new config, as the old example config had them. */
export const DEFAULT_ROLES: Record<Role, { model: string; effort?: (typeof EFFORTS)[number] }> = {
  planner: { model: "opus", effort: "high" },
  implementer: { model: "sonnet" },
  reviewer: { model: "opus" },
};

const ROLE_LABELS: Record<Role, string> = { planner: "Planner", implementer: "Implementer", reviewer: "Reviewer" };

/** REQ-007-08: a repository's `setup` command, guessed from its lockfile; undefined when there is none to go by. */
export function guessSetup(files: readonly string[]): string | undefined {
  const has = (f: string) => files.includes(f);
  if (has("bun.lock") || has("bun.lockb")) return "bun install";
  if (has("pnpm-lock.yaml")) return "pnpm install";
  if (has("yarn.lock")) return "yarn install";
  if (has("package-lock.json")) return "npm ci";
  if (has("uv.lock")) return "uv sync";
  if (has("poetry.lock")) return "poetry install";
  if (has("Gemfile.lock")) return "bundle install";
  if (has("go.sum")) return "go mod download";
  if (has("Cargo.lock")) return "cargo fetch";
  return undefined;
}

export const PAT_HELP = `GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token

  Resource owner      the account that owns the repositories
  Repository access   Only select repositories: the ones the Coordinator manages
  Read & write        Contents, Issues, Pull requests, Workflows
  Read-only           Commit statuses, Actions

See docs/setup.md step 1.`;

const ACCOUNT_NAME = /^[\w.-]+$/;
const required = (what: string) => (v: string) => (v.trim() ? undefined : `${what} is needed`);

/** What `init` keeps of an existing config, and where it is. */
interface Existing {
  raw: Json;
  stateDir: string;
}

/** Runs `issueflow init` for the config at `configPath`; returns the exit code. */
export async function init(configPath: string, p: Prompter, env: InitEnv): Promise<number> {
  p.intro("Issueflow setup");
  try {
    const existing = await startingPoint(configPath, p, env);
    if (existing === null) {
      p.outro("Nothing changed.");
      return 0;
    }
    const { raw, secrets } = await ask(p, env, existing);
    try {
      parseConfig(raw, { configPath });
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      p.note(e.issues.join("\n"), "The answers don't make a valid config; nothing was written");
      return 1;
    }
    // REQ-007-10: only the user can read them.
    for (const [path, content] of secrets) env.writeFile(path, `${content}\n`, 0o600);
    env.writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    p.info(`Wrote ${configPath}`);
    const problems = await env.doctor(configPath);
    if (problems) p.note("Fix what the check names, then run `issueflow doctor` again.", "Not all set yet");
    if (await p.confirm({ message: "Install and start the systemd service now?", initial: problems === 0 })) {
      const code = await env.serviceInstall(configPath);
      if (code) return code;
    } else p.info("Later: `sudo issueflow service install`");
    p.outro("Done.");
    return 0;
  } catch (e) {
    if (e instanceof InitError) {
      p.outro(`${e.message} Nothing was written.`);
      return 1;
    }
    if (!(e instanceof Cancelled)) throw e;
    p.outro("Cancelled; nothing was written.");
    return 1;
  }
}

/**
 * REQ-007-09: a new config, or the existing one to edit; null when the Owner stops. Nothing is overwritten without
 * asking.
 */
async function startingPoint(configPath: string, p: Prompter, env: InitEnv): Promise<Existing | undefined | null> {
  const text = env.readFile(configPath);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {}
  const editable = isObject(raw);
  const choice = await p.select<"edit" | "new" | "stop">({
    message: `${configPath} exists${editable ? "" : " but isn't valid JSON"}. What now?`,
    options: [
      ...(editable ? [{ value: "edit" as const, label: "Edit it", hint: "its values preselected" }] : []),
      { value: "new", label: "Start over", hint: "replaces the file" },
      { value: "stop", label: "Stop", hint: "change nothing" },
    ],
    initial: editable ? "edit" : "stop",
  });
  if (choice === "stop") return null;
  if (choice === "new" || !isObject(raw)) return undefined;
  const stateDir = typeof raw.stateDir === "string" ? resolve(dirname(configPath), raw.stateDir) : env.defaultStateDir;
  return { raw, stateDir };
}

/**
 * Asks every question; returns the config's JSON, the existing config's keys kept in their place, and the secret
 * files to write (path → content) once it is valid.
 */
async function ask(
  p: Prompter,
  env: InitEnv,
  existing: Existing | undefined,
): Promise<{ raw: Json; secrets: Map<string, string> }> {
  const old = existing?.raw ?? {};
  const stateDir = existing?.stateDir ?? env.defaultStateDir;
  const secrets = new Map<string, string>();

  await githubLogin(p, env);
  const owner = await ownerOf(p, env, old);
  const repos = await reposOf(p, env, old);
  const editing = existing !== undefined;
  const harnesses = await harnessesOf(p, env, old, editing);
  const roles = await rolesOf(p, old, harnesses);
  const dashboard = await dashboardOf(p, env, old, stateDir, secrets);
  const accounts = await accountsOf(p, env, old, harnesses, editing);
  const autoMerge = await p.select<AutoMergeMode>({
    message: "What should the Coordinator merge itself once a PR passed its Review and checks?",
    options: [
      { value: "evaluated", label: "evaluated", hint: "PRs the Reviewer rated low risk" },
      { value: "off", label: "off", hint: "you merge everything" },
      { value: "all", label: "all", hint: "every PR that passed" },
    ],
    initial: old.autoMerge === "off" || old.autoMerge === "all" ? old.autoMerge : "evaluated",
  });

  const raw: Json = { $schema: env.schemaUrl, ...old };
  raw.$schema = env.schemaUrl;
  raw.owner = owner;
  raw.repos = repos;
  raw.roles = roles;
  raw.autoMerge = autoMerge;
  if (accounts) raw.accounts = accounts;
  raw.dashboard = dashboard;
  return { raw, secrets };
}

/** Step 1: the GitHub CLI's login, with a fine-grained PAT. */
async function githubLogin(p: Prompter, env: InitEnv) {
  if (env.ghLoggedIn()) {
    p.info("GitHub CLI: logged in");
    return;
  }
  p.note(PAT_HELP, "GitHub access: a fine-grained personal access token");
  for (;;) {
    const token = await p.password({ message: "Paste the token (github_pat_…)", validate: required("The token") });
    const r = env.ghLogin(token.trim());
    if (r.ok) return;
    p.info(`gh auth login failed: ${r.out}`);
  }
}

/** Step 2: the Owner, from the logged-in account. */
async function ownerOf(p: Prompter, env: InitEnv, old: Json) {
  const me = await env.ghUser();
  const oldOwner = isObject(old.owner) && typeof old.owner.login === "string" ? old.owner.login : undefined;
  if (oldOwner && oldOwner.toLowerCase() !== me.login.toLowerCase()) {
    const keep = await p.confirm({
      message: `Keep ${oldOwner} as the Owner (the token is ${me.login}'s)?`,
      initial: true,
    });
    if (keep) return env.ghUser(oldOwner);
  }
  const yes = await p.confirm({
    message: `The Owner, the only person whose issues, comments and reviews count: ${me.login} (id ${me.id})?`,
    initial: true,
  });
  if (yes) return { login: me.login, id: me.id };
  const login = await p.text({ message: "The Owner's GitHub login", validate: required("A login") });
  return env.ghUser(login.trim());
}

/** Step 3: the repositories, each with its `setup` command. */
async function reposOf(p: Prompter, env: InitEnv, old: Json): Promise<Json[]> {
  const oldRepos = (Array.isArray(old.repos) ? old.repos : []).filter(isObject);
  const oldNames = oldRepos.map((r) => String(r.name));
  const visible = await env.ghRepos();
  const names = [...new Set([...oldNames, ...visible])];
  if (!names.length)
    throw new InitError(
      "The token sees no repository it can push to. Give it access to the repositories to manage (docs/setup.md step 1).",
    );
  const picked = await p.multiselect({
    message: "Which repositories should the Coordinator manage?",
    options: names.map((n) => ({
      value: n,
      label: n,
      ...(visible.includes(n) ? {} : { hint: "not visible to the token" }),
    })),
    initial: oldNames,
  });
  const repos: Json[] = [];
  for (const name of picked) {
    const was = oldRepos.find((r) => String(r.name).toLowerCase() === name.toLowerCase());
    const guess = was
      ? typeof was.setup === "string"
        ? was.setup
        : ""
      : (guessSetup(await env.rootFiles(name)) ?? "");
    const setup = (
      await p.text({
        message: `${name}: command to run in each new Worktree (empty: none)`,
        initial: guess,
        placeholder: "e.g. bun install",
      })
    ).trim();
    const repo: Json = { ...(was ?? { name }) };
    if (setup) repo.setup = setup;
    else delete repo.setup;
    repos.push(repo);
  }
  return repos;
}

/**
 * Step 4: the Harnesses to use. A new config preselects those whose CLI is on the PATH, else Claude Code; an existing
 * one those of its Accounts and Role models (REQ-007-09).
 */
async function harnessesOf(p: Prompter, env: InitEnv, old: Json, editing: boolean): Promise<HarnessName[]> {
  const inUse = new Set<HarnessName>();
  if (editing) {
    const accounts = (Array.isArray(old.accounts) ? old.accounts : []).filter(isObject);
    // Without `accounts`, the config runs on Claude Code's default Account.
    if (!accounts.length) inUse.add("claude");
    for (const a of accounts) inUse.add(harnessOfAccount({ name: String(a.name), harness: a.harness as HarnessName }));
    const repoRoles = (Array.isArray(old.repos) ? old.repos : []).map((r) => (isObject(r) ? r.roles : undefined));
    for (const roles of [old.roles, ...repoRoles])
      for (const r of isObject(roles) ? Object.values(roles) : [])
        if (isObject(r) && typeof r.model === "string") inUse.add(harnessOfModel(r.model));
  }
  const found = editing
    ? HARNESS_NAMES.filter((h) => inUse.has(h))
    : HARNESS_NAMES.filter((h) => env.onPath(HARNESSES[h].bin));
  return p.multiselect({
    message: "Which Harnesses (agent CLIs) are installed and logged in?",
    options: HARNESS_NAMES.map((h) => ({ value: h, label: HARNESSES[h].label, hint: `\`${HARNESSES[h].bin}\`` })),
    initial: found.length ? found : ["claude"],
  });
}

/** The model a new Role gets: today's Claude default, else the first model of the first Harness picked. */
const defaultModel = (role: Role, harnesses: readonly HarnessName[]): string => {
  const first = harnesses[0];
  return harnesses.includes("claude") || !first
    ? DEFAULT_ROLES[role].model
    : (HARNESS_MODELS[first][0]?.value ?? DEFAULT_ROLES[role].model);
};

/** Step 5: the model and effort per Role, from the picked Harnesses' models. */
async function rolesOf(p: Prompter, old: Json, harnesses: readonly HarnessName[]) {
  const oldRoles = isObject(old.roles) ? old.roles : {};
  const roles: Json = { ...oldRoles };
  for (const role of ROLES) {
    const was = isObject(oldRoles[role]) ? oldRoles[role] : {};
    const oldModel = typeof was.model === "string" ? was.model : undefined;
    const model = oldModel && harnesses.includes(harnessOfModel(oldModel)) ? oldModel : defaultModel(role, harnesses);
    const effort = isObject(oldRoles[role])
      ? typeof was.effort === "string"
        ? was.effort
        : ""
      : (DEFAULT_ROLES[role].effort ?? "");
    const models: Choice<string>[] = harnesses.flatMap((h) =>
      HARNESS_MODELS[h].map((m) => ({ value: m.value, label: m.label, hint: HARNESSES[h].label })),
    );
    if (!models.some((m) => m.value === model))
      models.unshift({ value: model, label: modelLabel(model), hint: HARNESSES[harnessOfModel(model)].label });
    const picked = await p.select({ message: `${ROLE_LABELS[role]}: model`, options: models, initial: model });
    const pickedEffort = await p.select<string>({
      message: `${ROLE_LABELS[role]}: effort`,
      options: [
        { value: "", label: "default", hint: "the model's own" },
        ...EFFORTS.map((e) => ({ value: e, label: e })),
      ],
      initial: effort,
    });
    roles[role] = { ...was, model: picked, ...(pickedEffort ? { effort: pickedEffort } : {}) };
    if (!pickedEffort) delete (roles[role] as Json).effort;
  }
  return roles;
}

/** Steps 6 and 7: the dashboard, its GitHub sign-in and an optional token; secrets go to `secrets`. */
async function dashboardOf(p: Prompter, env: InitEnv, old: Json, stateDir: string, secrets: Map<string, string>) {
  const was = isObject(old.dashboard) ? old.dashboard : undefined;
  const on = await p.select<"github" | "off">({
    message: "The web dashboard",
    options: [
      { value: "github", label: "On, with Sign in with GitHub", hint: "only you get in" },
      { value: "off", label: "Off" },
    ],
    initial: old.dashboard === false ? "off" : "github",
  });
  if (on === "off") return false;
  const dashboard: Json = { ...was };
  const host = typeof was?.host === "string" ? was.host : "127.0.0.1";
  const port = typeof was?.port === "number" ? was.port : 8080;
  const url = (
    await p.text({
      message: "The dashboard's address as your browser opens it (e.g. through Tailscale or an SSH tunnel)",
      initial: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
      validate: (v) =>
        /^https?:\/\/[^/\s]+\/?$/.test(v.trim()) ? undefined : "an http(s) address, e.g. http://127.0.0.1:8080",
    })
  )
    .trim()
    .replace(/\/$/, "");
  p.note(
    `GitHub → Settings → Developer settings → OAuth Apps → New OAuth App\n\n  Homepage URL                ${url}\n  Authorization callback URL  ${url}/auth/callback\n\nThen generate a client secret.`,
    "Register a GitHub OAuth App",
  );
  const login = isObject(was?.githubLogin) ? was.githubLogin : {};
  const oldId = typeof login.clientId === "string" ? login.clientId : undefined;
  const oldSecret = typeof login.clientSecretPath === "string" ? login.clientSecretPath : undefined;
  const clientId = (
    await p.text({ message: "The OAuth App's client id", initial: oldId, validate: required("The client id") })
  ).trim();
  const keep = oldSecret !== undefined && env.readFile(oldSecret) !== undefined;
  const secret = (
    await p.password({
      message: keep ? "Its client secret (empty: keep the saved one)" : "Its client secret",
      validate: keep ? undefined : required("The client secret"),
    })
  ).trim();
  // REQ-007-10: only the file's path goes into the config.
  const secretPath = secret || !oldSecret ? join(stateDir, "github-client-secret") : oldSecret;
  if (secret) secrets.set(secretPath, secret);
  dashboard.githubLogin = { ...login, clientId, clientSecretPath: secretPath };

  const oldToken = typeof was?.tokenPath === "string" ? was.tokenPath : undefined;
  const token = await p.confirm({
    message: "A dashboard token too, for scripts (sent as Authorization: Bearer)?",
    initial: oldToken !== undefined,
  });
  if (!token) delete dashboard.tokenPath;
  else if (!oldToken || env.readFile(oldToken) === undefined) {
    const tokenPath = oldToken ?? join(stateDir, "dashboard-token");
    secrets.set(tokenPath, env.randomToken());
    dashboard.tokenPath = tokenPath;
    p.info(`The token will be in ${tokenPath}`);
  }
  return dashboard;
}

/** The name of a picked Harness's first Account: `main` for Claude Code, as before, else the Harness's name. */
const firstAccountName = (h: HarnessName) => (h === "claude" ? "main" : h);

/**
 * Step 8: an Account in its default folder for each picked Harness without one, then optional extra Accounts for a
 * Harness with a per-Account folder (REQ-006-09); each new one with its login step. The existing Accounts are kept.
 */
async function accountsOf(
  p: Prompter,
  env: InitEnv,
  old: Json,
  harnesses: readonly HarnessName[],
  editing: boolean,
): Promise<Json[] | undefined> {
  const oldAccounts = (Array.isArray(old.accounts) ? old.accounts : []).filter(isObject);
  const accounts = [...oldAccounts];
  const harnessOf = (a: Json) => harnessOfAccount({ name: String(a.name), harness: a.harness as HarnessName });
  const taken = (name: string) => accounts.some((a) => a.name === name);
  const logins: string[] = [];
  // Without `accounts`, an existing config runs on Claude Code's default Account, which needs no new login.
  const implicitClaude = editing && oldAccounts.length === 0;
  for (const h of harnesses) {
    if (accounts.some((a) => harnessOf(a) === h)) continue;
    let name = firstAccountName(h);
    for (let n = 2; taken(name); n++) name = `${firstAccountName(h)}-${n}`;
    accounts.push(h === "claude" ? { name } : { name, harness: h });
    if (!(h === "claude" && implicitClaude)) logins.push(`${HARNESSES[h].label}: ${HARNESSES[h].loginStep()}`);
  }
  const withFolders = harnesses.filter((h) => HARNESSES[h].accountEnv);
  const more =
    withFolders.length > 0 &&
    (await p.confirm({
      message: `Add extra Accounts (another subscription of ${withFolders.map((h) => HARNESSES[h].label).join(" or ")} for when one hits its limit)?`,
      initial: false,
    }));
  while (more) {
    const name = (
      await p.text({
        message: "Name of the extra Account (empty: done)",
        validate: (v) =>
          !v.trim()
            ? undefined
            : !ACCOUNT_NAME.test(v.trim())
              ? "letters, digits, '.', '_' or '-' only"
              : taken(v.trim())
                ? "that name is taken"
                : undefined,
      })
    ).trim();
    if (!name) break;
    const first = withFolders[0] as HarnessName;
    const h =
      withFolders.length === 1
        ? first
        : await p.select<HarnessName>({
            message: `${name}: which Harness?`,
            options: withFolders.map((x) => ({ value: x, label: HARNESSES[x].label })),
            initial: first,
          });
    const harness = HARNESSES[h];
    const configDir = (
      await p.text({
        message: `${name}: its own ${harness.label} config folder`,
        initial: join(env.home, `${harness.defaultAccountFolder}-${name}`),
        validate: required("A folder"),
      })
    ).trim();
    accounts.push(h === "claude" ? { name, configDir } : { name, harness: h, configDir });
    logins.push(`${name}: ${harness.loginStep(configDir)}`);
  }
  if (logins.length) p.note(logins.join("\n"), "Log in to each new Account once");
  // REQ-007-08: Claude Code's default Account alone is what a config without `accounts` means already.
  const onlyDefault =
    accounts.length === 1 &&
    Object.keys(accounts[0] as Json).length === 1 &&
    harnessOf(accounts[0] as Json) === "claude";
  if (!oldAccounts.length && onlyDefault) return undefined;
  return accounts;
}

/** A problem `init` can't go past; it stops with the message. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}
