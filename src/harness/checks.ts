/** REQ-006-05: what `issueflow doctor` checks per Harness in use: its CLI, its version and each Account's login. */
import { homedir } from "node:os";
import { type Account, accountDir, harnessOfAccount } from "../accounts.ts";
import { HARNESSES, type Harness, type LoginStatus, versionAtLeast } from "./index.ts";

export type CheckStatus = "ok" | "fail" | "warn";
export interface Check {
  status: CheckStatus;
  check: string;
  detail: string;
}
export type Run = (cmd: string[], env?: Record<string, string | undefined>) => { ok: boolean; out: string };

export function harnessChecks(accounts: readonly Account[], run: Run, env = process.env): Check[] {
  const checks: Check[] = [];
  const inUse = [...new Set(accounts.map(harnessOfAccount))];
  for (const name of inUse) {
    const h = HARNESSES[name];
    const r = run([h.bin, "--version"]);
    const line = r.out.split("\n").find((l) => /\d+\.\d+/.test(l)) ?? r.out.split("\n")[0] ?? "";
    const version = /(\d+\.\d+(?:\.\d+)?)/.exec(line)?.[1];
    if (!r.ok) checks.push({ status: "fail", check: `${h.bin} installed`, detail: "not found" });
    else if (version && !versionAtLeast(version, h.minVersion))
      checks.push({
        status: "warn",
        check: `${h.bin} installed`,
        detail: `${line}; checked with ${h.minVersion} or newer`,
      });
    else checks.push({ status: "ok", check: `${h.bin} installed`, detail: line });

    const own = accounts.filter((a) => harnessOfAccount(a) === name);
    for (const a of own) {
      const named = accounts.length > 1 || a.configDir;
      const check = named ? `${h.bin} logged in (Account ${a.name})` : `${h.bin} logged in`;
      const login = a.configDir && h.accountEnv ? `${h.accountEnv}=${a.configDir} ${h.bin}` : h.bin;
      const result = loginStatus(h, a, run, env);
      checks.push({
        status: result.ok ? "ok" : "fail",
        check,
        detail: result.ok ? result.detail : `${result.detail.replace(/^run it/, `run \`${login}\``)}`,
      });
    }
  }
  return checks;
}

/** REQ-006-05: an Account's login, by its Harness's CLI command or, without one, its folder (Copilot CLI). */
export function loginStatus(h: Harness, a: Account, run: Run, env = process.env): LoginStatus {
  const check = h.loginCheck;
  if ("readFolder" in check) return check.readFolder(accountDir(a, env.HOME ?? homedir()), env);
  const folderEnv = a.configDir && h.accountEnv ? { [h.accountEnv]: a.configDir } : undefined;
  return check.read(run([h.bin, ...check.args], folderEnv ? { ...env, ...folderEnv } : env));
}
