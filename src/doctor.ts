#!/usr/bin/env bun
/**
 * Setup check: `bun run doctor`. Verifies everything the Coordinator needs before its first start
 * (docs/setup.md) and prints what is missing. Read-only: it changes nothing.
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { AppAuth, createAppJwt } from "./github/app-auth.ts";
import { API, baseHeaders } from "./github/http.ts";

type Status = "ok" | "fail" | "warn";
const results: { status: Status; check: string; detail: string }[] = [];
const report = (status: Status, check: string, detail = "") => {
  results.push({ status, check, detail });
  console.log(`${{ ok: "✓", fail: "✗", warn: "!" }[status]} ${check}${detail ? `: ${detail}` : ""}`);
};
const run = (cmd: string[]) => {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim() || p.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
};

for (const [bin, arg] of [
  ["claude", "--version"],
  ["tmux", "-V"],
  ["git", "--version"],
  // Claude Code's sandbox needs both; without them the Implementer runs no commands (failIfUnavailable).
  ["bwrap", "--version"],
  ["socat", "-V"],
] as const) {
  const r = run([bin, arg]);
  const line = r.out.split("\n").find((l) => /version/i.test(l)) ?? r.out.split("\n")[0];
  report(r.ok ? "ok" : "fail", `${bin} installed`, r.ok ? line : "not found");
}
// The Implementer's sandbox runs a helper inside bubblewrap that needs its own user namespace;
// Ubuntu's bwrap-userns-restrict AppArmor profile forbids that (docs/setup.md, step 1).
const nested = run([
  "bwrap",
  "--ro-bind",
  "/",
  "/",
  "--unshare-user",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "unshare",
  "--user",
  "--map-root-user",
  "true",
]);
report(
  nested.ok ? "ok" : "fail",
  "sandbox can nest user namespaces",
  nested.ok ? "" : `${nested.out} (Ubuntu AppArmor; see docs/setup.md step 1)`,
);

// Both files define the profile `bwrap`; without the disable link, Ubuntu's wins again at boot.
if (existsSync("/etc/apparmor.d/bwrap-userns-restrict") && existsSync("/etc/apparmor.d/bwrap")) {
  const disabled = existsSync("/etc/apparmor.d/disable/bwrap-userns-restrict");
  report(
    disabled ? "ok" : "fail",
    "bwrap AppArmor change survives a reboot",
    disabled ? "" : "Ubuntu's bwrap-userns-restrict is not disabled (see docs/setup.md step 1)",
  );
}

const auth = run(["claude", "auth", "status"]);
try {
  const s = JSON.parse(auth.out) as { loggedIn?: boolean; subscriptionType?: string };
  report(
    s.loggedIn ? "ok" : "fail",
    "claude logged in",
    s.loggedIn ? `${s.subscriptionType ?? "?"} subscription` : "run `claude` and /login",
  );
} catch {
  report("fail", "claude logged in", "could not read `claude auth status`");
}

let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
try {
  config = await loadConfig(process.env.COORDINATOR_CONFIG ?? "config.ts");
  report("ok", "config valid", `${config.repos.length} repositories, Owner ${config.owner.login} (${config.owner.id})`);
} catch (e) {
  report("fail", "config valid", e instanceof Error ? e.message : String(e));
}

if (config) {
  const ownerRes = await fetch(`${API}/users/${config.owner.login}`, { headers: baseHeaders });
  const owner = ownerRes.ok ? ((await ownerRes.json()) as { id: number }) : undefined;
  if (owner)
    report(owner.id === config.owner.id ? "ok" : "fail", "Owner id matches the login", `GitHub says ${owner.id}`);

  const keyPath = config.github.privateKeyPath;
  let readable = true;
  try {
    accessSync(keyPath, constants.R_OK);
  } catch (e) {
    readable = false;
    const denied = (e as NodeJS.ErrnoException).code === "EACCES";
    report(
      "fail",
      "GitHub App private key",
      denied || !existsSync(dirname(keyPath))
        ? `${keyPath} is not readable by ${userInfo().username}; run doctor as the Coordinator's user (sudo -iu agent …)`
        : `${keyPath} not found`,
    );
  }
  if (readable) {
    const key = readFileSync(keyPath, "utf8");
    const app = await fetch(`${API}/app`, {
      headers: { ...baseHeaders, authorization: `Bearer ${createAppJwt(config.github.appId, key, new Date())}` },
    });
    const body = (await app.json()) as { slug?: string; permissions?: Record<string, string>; message?: string };
    report(
      app.ok ? "ok" : "fail",
      "GitHub App",
      app.ok ? `${body.slug}, permissions ${JSON.stringify(body.permissions)}` : (body.message ?? ""),
    );
    const wanted = { issues: "write", pull_requests: "write", contents: "write", checks: "read", metadata: "read" };
    for (const [perm, level] of Object.entries(wanted)) {
      const have = body.permissions?.[perm];
      if (app.ok && have !== level && !(level === "read" && have === "write"))
        report("fail", `App permission ${perm}`, `needs ${level}, has ${have ?? "none"}`);
    }
    const appAuth = new AppAuth({ appId: config.github.appId, privateKey: key });
    for (const { name } of config.repos) {
      try {
        const token = await appAuth.tokenFor(name);
        const repo = await fetch(`${API}/repos/${name}`, {
          headers: { ...baseHeaders, authorization: `token ${token}` },
        });
        const r = (await repo.json()) as { default_branch?: string; message?: string };
        report(
          repo.ok ? "ok" : "fail",
          `${name} reachable`,
          repo.ok ? `default branch ${r.default_branch}` : (r.message ?? ""),
        );
      } catch (e) {
        report(
          "fail",
          `${name} reachable`,
          `${e instanceof Error ? e.message : String(e)} (is the App installed on it?)`,
        );
      }
    }
  }
  report("warn", "default-branch rulesets", "not checkable with the App's permissions; see docs/setup.md step 3");
}

const failed = results.filter((r) => r.status === "fail").length;
console.log(failed ? `\n${failed} problem(s) to fix (docs/setup.md).` : "\nAll set.");
process.exit(failed ? 1 : 0);
