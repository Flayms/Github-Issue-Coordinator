import { describe, expect, test } from "bun:test";
import { type ServiceEnv, service, serviceUnit, UNIT_PATH } from "../src/service.ts";

const UNIT_INPUT = {
  bun: "/root/.bun/bin/bun",
  claude: "/root/.local/bin/claude",
  entry: "/root/.bun/install/global/node_modules/issueflow/src/cli.ts",
  configPath: "/root/.config/issueflow/config.json",
  user: "root",
  home: "/root",
};

/** A fake machine: records commands and files; `fail` names commands that exit non-zero. */
const fakeEnv = (o: { fail?: string[]; config?: boolean; writable?: boolean } = {}) => {
  const ran: string[] = [];
  const files = new Map<string, string>();
  const out: string[] = [];
  const env: ServiceEnv = {
    which: (bin) => ({ bun: UNIT_INPUT.bun, claude: UNIT_INPUT.claude })[bin],
    home: "/root",
    user: "root",
    entry: UNIT_INPUT.entry,
    exists: (p) => (p === UNIT_INPUT.configPath ? o.config !== false : files.has(p)),
    run: (cmd) => {
      ran.push(cmd.join(" "));
      return o.fail?.includes(cmd.join(" ")) ? 1 : 0;
    },
    writeFile: (p, text) => {
      if (o.writable === false)
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
      files.set(p, text);
    },
    removeFile: (p) => {
      files.delete(p);
    },
    print: (l) => out.push(l),
  };
  return { env, ran, files, out };
};

describe("issueflow service", () => {
  test("REQ-007-11 the unit is made from the environment and keeps agent sessions on a restart", () => {
    const unit = serviceUnit(UNIT_INPUT);
    expect(unit).toContain("User=root\n");
    expect(unit).toContain(
      "Environment=PATH=/root/.bun/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n",
    );
    expect(unit).toContain(`Environment=ISSUEFLOW_CONFIG=${UNIT_INPUT.configPath}\n`);
    expect(unit).toContain(
      `ExecStart=/root/.bun/bin/bun ${UNIT_INPUT.entry} start --config ${UNIT_INPUT.configPath}\n`,
    );
    expect(unit).toContain("KillMode=process\n");
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain("WantedBy=multi-user.target\n");
    expect(unit).not.toContain("WorkingDirectory=/root/issueflow");
  });

  test("REQ-007-11 bun and claude elsewhere are on PATH too; paths with spaces are quoted", () => {
    const unit = serviceUnit({
      ...UNIT_INPUT,
      bun: "/opt/bun/bin/bun",
      claude: "/usr/local/bin/claude",
      configPath: "/root/my config.json",
    });
    expect(unit).toContain(
      "Environment=PATH=/opt/bun/bin:/usr/local/bin:/root/.local/bin:/root/.bun/bin:/usr/local/sbin:",
    );
    expect(unit).toContain('Environment="ISSUEFLOW_CONFIG=/root/my config.json"\n');
    expect(unit).toContain(`ExecStart=/opt/bun/bin/bun ${UNIT_INPUT.entry} start --config "/root/my config.json"\n`);
  });

  test("REQ-007-11 install writes the unit, reloads systemd and enables and starts the service", async () => {
    const m = fakeEnv();
    expect(await service("install", UNIT_INPUT.configPath, m.env)).toBe(0);
    expect(m.files.get(UNIT_PATH)).toBe(serviceUnit(UNIT_INPUT));
    expect(UNIT_PATH).toBe("/etc/systemd/system/issueflow.service");
    expect(m.ran).toEqual(["systemctl daemon-reload", "systemctl enable --now issueflow"]);
    expect(m.out.join("\n")).toContain("issueflow service logs");
  });

  test("REQ-007-11 install without a config, without root, or with a failing systemctl stops with the reason", async () => {
    const noConfig = fakeEnv({ config: false });
    expect(await service("install", UNIT_INPUT.configPath, noConfig.env)).toBe(1);
    expect(noConfig.out.join("\n")).toContain("issueflow init");
    expect(noConfig.ran).toEqual([]);

    const notRoot = fakeEnv({ writable: false });
    expect(await service("install", UNIT_INPUT.configPath, notRoot.env)).toBe(1);
    expect(notRoot.out.join("\n")).toContain("sudo");
    expect(notRoot.ran).toEqual([]);

    const failing = fakeEnv({ fail: ["systemctl daemon-reload"] });
    expect(await service("install", UNIT_INPUT.configPath, failing.env)).toBe(1);
    expect(failing.out.join("\n")).toContain("systemctl daemon-reload failed");
    expect(failing.ran).toEqual(["systemctl daemon-reload"]);
  });

  test("REQ-007-11 uninstall stops, disables and removes the unit; status, logs and restart act on the service", async () => {
    const m = fakeEnv();
    m.files.set(UNIT_PATH, "unit");
    expect(await service("uninstall", UNIT_INPUT.configPath, m.env)).toBe(0);
    expect(m.files.has(UNIT_PATH)).toBe(false);
    expect(m.ran).toEqual(["systemctl disable --now issueflow", "systemctl daemon-reload"]);

    const o = fakeEnv({ fail: ["systemctl status issueflow --no-pager"] });
    expect(await service("status", UNIT_INPUT.configPath, o.env)).toBe(1);
    expect(await service("logs", UNIT_INPUT.configPath, o.env)).toBe(0);
    expect(await service("restart", UNIT_INPUT.configPath, o.env)).toBe(0);
    expect(o.ran).toEqual([
      "systemctl status issueflow --no-pager",
      "journalctl -u issueflow -f -n 100",
      "systemctl restart issueflow",
    ]);
  });
});
