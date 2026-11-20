/**
 * Setup check: `coordinator doctor`. Verifies everything the Coordinator needs before its first start
 * (docs/setup.md) and prints what is missing. Read-only: it changes nothing.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT } from "./accounts.ts";
import { type Config, deprecatedSettings, githubLoginOf, loadConfig, readConfigFile } from "./config.ts";
import { GhToken } from "./github/gh-token.ts";
import { API, baseHeaders } from "./github/http.ts";
import { harnessChecks } from "./harness/checks.ts";
import { tempSpaceChecks } from "./temp-space.ts";
import { VERSION, versionCheck } from "./version.ts";

type Status = "ok" | "fail" | "warn";
const run = (cmd: string[], env?: Record<string, string | undefined>) => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim() || p.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
};

/** Runs every check on the config file at `configPath`, printing each; returns the number of problems to fix. */
export async function doctor(configPath: string, print: (line: string) => void = console.log): Promise<number> {
  const results: { status: Status; check: string; detail: string }[] = [];
  const report = (status: Status, check: string, detail = "") => {
    results.push({ status, check, detail });
    print(`${{ ok: "✓", fail: "✗", warn: "!" }[status]} ${check}${detail ? `: ${detail}` : ""}`);
  };

  // REQ-007-12: the installed version, and whether npm has a newer one.
  const v = await versionCheck(VERSION);
  report(v.status, v.check, v.detail);

  for (const [bin, arg] of [
    ["tmux", "-V"],
    ["git", "--version"],
    ["gh", "--version"],
  ] as const) {
    const r = run([bin, arg]);
    const line = r.out.split("\n").find((l) => /version/i.test(l)) ?? r.out.split("\n")[0];
    report(r.ok ? "ok" : "fail", `${bin} installed`, r.ok ? line : "not found");
  }

  let config: Config | undefined;
  try {
    config = loadConfig(configPath);
    report(
      "ok",
      "config valid",
      `${configPath}: ${config.repos.length} repositories, Owner ${config.owner.login} (${config.owner.id})`,
    );
  } catch (e) {
    report("fail", "config valid", e instanceof Error ? e.message : String(e));
  }

  // REQ-001-65: old names still work, but should be renamed before they go away.
  if (config)
    for (const d of deprecatedSettings(readConfigFile(configPath).raw)) report("warn", "deprecated config value", d);

  // REQ-005-08: sessions keep their temp files in their session folder (REQ-001-62); `/tmp` is often a small tmpfs.
  // Without a valid config the state folder isn't known; it may not exist yet either.
  if (config)
    for (const c of tempSpaceChecks({ sessions: config.stateDir, tmp: "/tmp" })) report(c.status, c.check, c.detail);

  // REQ-003-29: the dashboard's GitHub sign-in is on by default; its client secret must be readable.
  if (config?.dashboard && config.dashboard.githubLogin !== false) {
    const login = githubLoginOf(config);
    let secret = "";
    try {
      secret = login ? readFileSync(login.clientSecretPath, "utf8").trim() : "";
    } catch {}
    report(
      login && secret ? "ok" : "fail",
      "dashboard GitHub sign-in",
      !login
        ? "not set up: run `coordinator init`, or set dashboard.githubLogin (docs/setup.md step 4), or githubLogin: false"
        : secret
          ? `OAuth App ${login.clientId}`
          : `cannot read a client secret at ${login.clientSecretPath}`,
    );
  }

  // REQ-004-03 / REQ-006-05: each Harness in use (its CLI and version) and every Account's login, each in its own config
  // folder; without a config, Claude Code's default one.
  for (const c of harnessChecks(config?.accounts ?? [DEFAULT_ACCOUNT], run)) report(c.status, c.check, c.detail);

  // REQ-005-02: the one GitHub credential, the GitHub CLI's fine-grained PAT.
  let token: string | undefined;
  try {
    token = await new GhToken().tokenFor("");
    report("ok", "gh logged in");
  } catch (e) {
    report("fail", "gh logged in", e instanceof Error ? e.message : String(e));
  }

  if (config && token) {
    const auth = { ...baseHeaders, authorization: `token ${token}` };
    const me = await fetch(`${API}/user`, { headers: auth });
    const user = me.ok ? ((await me.json()) as { login: string; id: number }) : undefined;
    report(
      user ? "ok" : "fail",
      "GitHub token's account",
      user
        ? `${user.login}${user.id === config.owner.id ? " (the Owner; the Coordinator's posts are told apart by their agent note)" : ""}`
        : `GitHub says ${me.status}`,
    );
    const ownerRes = await fetch(`${API}/users/${config.owner.login}`, { headers: auth });
    const owner = ownerRes.ok ? ((await ownerRes.json()) as { id: number }) : undefined;
    if (owner)
      report(owner.id === config.owner.id ? "ok" : "fail", "Owner id matches the login", `GitHub says ${owner.id}`);

    for (const { name } of config.repos) {
      const repo = await fetch(`${API}/repos/${name}`, { headers: auth });
      const r = (await repo.json()) as { default_branch?: string; permissions?: { push?: boolean }; message?: string };
      if (!repo.ok) {
        report("fail", `${name} reachable`, `${r.message ?? repo.status} (is it among the PAT's repositories?)`);
        continue;
      }
      report(
        r.permissions?.push ? "ok" : "fail",
        `${name} reachable`,
        r.permissions?.push
          ? `default branch ${r.default_branch}`
          : "the token can't push (the PAT needs Contents read & write)",
      );
      const checks = await fetch(`${API}/repos/${name}/commits/${r.default_branch}/check-runs?per_page=1`, {
        headers: auth,
      });
      report(
        checks.ok ? "ok" : "fail",
        `${name} check runs readable`,
        checks.ok ? "" : `GitHub says ${checks.status} (the Reviewer waits for checks; see docs/setup.md step 1)`,
      );
    }
    report("warn", "default-branch rulesets", "not checked; see docs/setup.md step 2");
  }

  const failed = results.filter((r) => r.status === "fail").length;
  print(failed ? `\n${failed} problem(s) to fix (docs/setup.md).` : "\nAll set.");
  return failed;
}
