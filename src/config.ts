/**
 * Coordinator config: a typed TS module (default export) validated at startup.
 * See docs/specs/001-issue-coordinator/plan.md ("Config sketch").
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const ROLES = ["planner", "implementer", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

const positiveInt = z.number().int().positive();

const roleSchema = z.strictObject({
  model: z.string().min(1),
  effort: z.enum(EFFORTS).optional(),
});

const roleOverrideSchema = roleSchema.partial();

const repoSchema = z.strictObject({
  name: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo"),
  /** Shell command run once in each new Worktree, e.g. `bun install`. */
  setup: z.string().min(1).optional(),
  /** Network domains the Implementer's sandboxed shell commands may reach (REQ-001-25). */
  sandboxDomains: z.array(z.string().min(1)).default(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]),
  roles: z
    .strictObject({ planner: roleOverrideSchema, implementer: roleOverrideSchema, reviewer: roleOverrideSchema })
    .partial()
    .optional(),
});

const limitsSchema = z
  .strictObject({
    maxRunning: positiveInt.default(1),
    maxPlanners: positiveInt.default(1),
    maxImplementers: positiveInt.default(1),
    maxReviewers: positiveInt.default(1),
    /** Live `claude` processes, running and idle together (REQ-001-20). */
    maxLiveSessions: positiveInt.default(2),
    idleTimeoutMin: positiveInt.default(30),
    maxWorktrees: positiveInt.default(5),
    maxFeedbackRounds: z.number().int().nonnegative().default(2),
  })
  .refine((l) => l.maxRunning <= l.maxLiveSessions, {
    path: ["maxRunning"],
    message: "must not exceed maxLiveSessions (running sessions are live sessions)",
  });

const configSchema = z
  .strictObject({
    owner: z.strictObject({ login: z.string().min(1), id: positiveInt }),
    /** The Coordinator's GitHub identity: a private GitHub App (REQ-001-15). Keep the key outside the repo. */
    github: z.strictObject({
      appId: positiveInt,
      privateKeyPath: z.string().min(1),
      /** Author of the Implementer's commits. */
      commitAuthor: z
        .strictObject({ name: z.string().min(1), email: z.string().min(3) })
        .default({ name: "Claude", email: "noreply@anthropic.com" }),
    }),
    pollIntervalSec: positiveInt.default(60),
    /** Store, session files and clones; relative paths are resolved against the working directory. */
    stateDir: z.string().min(1).default("state"),
    limits: limitsSchema.prefault({}),
    roles: z.strictObject({ planner: roleSchema, implementer: roleSchema, reviewer: roleSchema }),
    repos: z.array(repoSchema).min(1),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.repos.forEach((r, i) => {
      const key = r.name.toLowerCase();
      if (seen.has(key))
        ctx.addIssue({ code: "custom", path: ["repos", i, "name"], message: `duplicate repository ${key}` });
      seen.add(key);
    });
  });

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
export type Limits = Config["limits"];
export type RoleSettings = z.output<typeof roleSchema>;

export class ConfigError extends Error {
  constructor(
    readonly issues: string[],
    source = "config",
  ) {
    super(`invalid ${source}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Typed helper for writing `config.ts`. */
export const defineConfig = (c: ConfigInput): ConfigInput => c;

export function parseConfig(raw: unknown, source?: string): Config {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    source,
  );
}

export async function loadConfig(path: string): Promise<Config> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`config file not found: ${abs}`);
  const mod = await import(abs);
  return parseConfig(mod.default, abs);
}

/** Model and effort for a Role in a repository; the repository's override wins (REQ-001-22). */
export function roleSettings(config: Config, repo: string, role: Role): RoleSettings {
  const r = config.repos.find((x) => x.name.toLowerCase() === repo.toLowerCase());
  if (!r) throw new Error(`repository ${repo} is not configured`);
  return { ...config.roles[role], ...r.roles?.[role] };
}
