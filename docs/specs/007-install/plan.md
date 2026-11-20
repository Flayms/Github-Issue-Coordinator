# 007 – Install: Plan

## Approach

- **One entry point**, `src/cli.ts` (the package's `bin`), parses the global `--config` flag and dispatches to `start` (`src/index.ts`), `doctor` (`src/doctor.ts`), `init` (`src/init/`) and `service` (`src/service.ts`). Each command is a function taking its dependencies, so tests call it without a TTY, systemd or GitHub.
- **Locations** in `src/paths.ts`: the XDG config and data folders, the config path from flag, environment or default.
- **The config file** (`src/config-file.ts`, replacing `src/overrides.ts`): `ConfigFile` reads `config.json`, keeps the startup config for the restart-only parts (REQ-007-07) and the current one for the rest. `reload()` runs before every tick: when the file's modification time or size changed it is read again; an invalid file is logged and the last valid config kept (REQ-007-06). `save(change)` reads the file from disk, applies the Config page's change to the raw JSON (keys keep their place, `null` removes one), validates the result as a whole config, writes a temp file and renames it (REQ-007-05). The allow-list of editable keys stays a zod schema of its own, as the overrides' was.
- **The JSON Schema** is generated from the zod schema with `z.toJSONSchema` (input side) into `config.schema.json` by `bun run schema`; a test compares the file with a fresh generation (REQ-007-04).
- **The wizard** (`src/init/`) asks through a small `Prompter` interface (text, password, confirm, select, multi-select, notes) and reaches the outside world through an `InitEnv` interface (`gh` calls, file writes, the doctor, the service install). `src/init/clack.ts` implements the Prompter with `@clack/prompts`; tests use a scripted Prompter and a fake env.
- **The service**: `serviceUnit()` builds the unit text from the environment (pure, tested); `service()` runs `systemctl` / `journalctl` through an injected runner.
- **Releases**: `release.yml` runs release-please (pinned by SHA) with a token from a GitHub App, and a second job publishes the tag to npm through trusted publishing when a release was created. `pr-title.yml` checks PR titles. A test reads the release config files (REQ-007-13, REQ-007-14).
- **Version**: `src/version.ts` reads `package.json`; `doctor` asks the npm registry for the latest version.

## Tasks

- [x] `spec.md`, deprecate REQ-003-36
- [x] XDG paths and the JSON config loader (REQ-007-02, REQ-007-03)
- [x] `config.schema.json` and its test (REQ-007-04)
- [x] `ConfigFile`: save into the file, reload, restart-only parts (REQ-007-05, REQ-007-06, REQ-007-07)
- [x] Config page: no base values or Reset, restart notice, version (REQ-007-05, REQ-007-07, REQ-007-12)
- [x] `coordinator` CLI (REQ-007-01, REQ-007-12)
- [x] `coordinator init` (REQ-007-08, REQ-007-09, REQ-007-10)
- [x] `coordinator service` (REQ-007-11)
- [x] `doctor`: JSON config, version check (REQ-007-12)
- [x] `package.json` `bin`/`files`/`version`, pack test (REQ-007-15)
- [x] release-please, PR title check, prompts (REQ-007-13, REQ-007-14)
- [x] Remove `config.example.ts`, `deploy/`, `src/overrides.ts`; docs
