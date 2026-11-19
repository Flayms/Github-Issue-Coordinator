/** REQ-006-05: what `bun run doctor` checks per Harness in use: its CLI, its version and each Account's login. */
import { type Account, harnessOfAccount } from "../accounts.ts";
import { HARNESSES, versionAtLeast } from "./index.ts";

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
      const folderEnv = a.configDir && h.accountEnv ? { [h.accountEnv]: a.configDir } : undefined;
      const login = folderEnv ? `${h.accountEnv}=${a.configDir} ${h.bin}` : h.bin;
      const result = h.loginCheck.read(run([h.bin, ...h.loginCheck.args], folderEnv ? { ...env, ...folderEnv } : env));
      checks.push({
        status: result.ok ? "ok" : "fail",
        check,
        detail: result.ok ? result.detail : `${result.detail.replace(/^run it/, `run \`${login}\``)}`,
      });
    }
  }
  return checks;
}
