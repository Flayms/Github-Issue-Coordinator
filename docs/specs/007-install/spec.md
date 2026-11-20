# 007 – Install

**Status:** Implemented

## Goal

Installing the Coordinator meant cloning the repository, copying `config.example.ts` to `config.ts` and editing TypeScript by hand: looking up the Owner's numeric id, typing repository names, pasting the OAuth App's id and creating secret files. The systemd unit named a fixed checkout, and the state folder depended on where the command was started. Now the Owner installs a package, answers a few questions, and the service runs: `bun add -g github-issue-coordinator`, then `coordinator init`. Updating is `bun add -g github-issue-coordinator@latest && coordinator service restart`. The config is one JSON file the dashboard edits in place, so the Owner's hand edits and the dashboard's saves never fight. A release is merging the release PR that release-please keeps open, with no version typed by hand (#187).

## Requirements

Deprecates REQ-003-36 (replaced by REQ-007-05 to REQ-007-07). Where other requirements say `config.ts`, they now mean the config file (REQ-007-02); `bun start` is now `coordinator start` and `bun run doctor` is `coordinator doctor` (REQ-007-01).

### REQ-007-01 One `coordinator` command

- **Given** the package installed globally (`bun add -g github-issue-coordinator`), or a checkout run as `bun src/cli.ts`
- **When** the Owner runs `coordinator <command>`
- **Then** `init` runs the setup wizard (REQ-007-08), `start` runs the Coordinator, `doctor` the setup check, and `service install | uninstall | status | logs | restart` manage the systemd service (REQ-007-11)
- **And** `--config <path>`, before or after the command, names the config file; without it `$COORDINATOR_CONFIG`, then the default location (REQ-007-02)
- **And** `--version` prints the package's version; `--help`, no command or an unknown one print the usage, the last two with a non-zero exit code

### REQ-007-02 The config is one JSON file in the user's config folder

- **Given** no `--config` and no `$COORDINATOR_CONFIG`
- **When** any command reads the config
- **Then** it reads `$XDG_CONFIG_HOME/github-issue-coordinator/config.json`, or `~/.config/github-issue-coordinator/config.json` when `XDG_CONFIG_HOME` is unset or not an absolute path
- **And** the file is JSON, checked by the same rules as before; a `"$schema"` key is allowed
- **And** a missing file says so and names `coordinator init`; a `.ts` or `.js` path says that the config is a JSON file now, also naming `coordinator init`; a file that isn't JSON says so with the parser's message

### REQ-007-03 State lives in the user's data folder

- **Given** a config without `stateDir`
- **When** the Coordinator starts, from any working folder
- **Then** its store, session files, clones, Worktrees and the dashboard's session key are under `$XDG_DATA_HOME/github-issue-coordinator/` (default `~/.local/share/github-issue-coordinator/`), never under `./.coordinator`
- **And** a `stateDir` in the config is used instead; a relative one is read relative to the config file's folder, not the working folder

### REQ-007-04 A JSON Schema ships with the package

- **Given** the package
- **When** an editor opens a config whose `"$schema"` points at the package's `config.schema.json`
- **Then** it can complete and check every key the Coordinator accepts
- **And** the shipped schema is the one generated from the Coordinator's own config rules, so the two never differ

### REQ-007-05 The Config page saves into the config file

- **Given** the Owner signed in with GitHub (REQ-003-29, REQ-003-30)
- **When** they open the Config page
- **Then** these settings are fields of a form, each showing its current value: `pollIntervalSec`, `checksGraceSeconds`, every `limits` key, the model (from a list, REQ-003-40) and effort of each Role, globally and per repository (empty: the global one), `autoMerge` (REQ-001-65) as a choice of `off`, `evaluated (low risk only)` and `all`, globally and in each repository's card, where a "global (…)" choice uses the global mode, and the Extra instructions (REQ-003-44)
- **And** repositories, Accounts, `owner`, `github`, `dashboard`, `stateDir` and `setup` commands can't be changed there (a `setup` command is code the server runs)
- **Given** the Owner changes fields and saves
- **When** the values are valid for the config (e.g. `maxRunning` not above `maxLiveSessions`; a model from the list)
- **Then** the changed values are written into the config file itself, the page says they were saved, and the Coordinator uses them from its next tick on, without a restart; a lowered limit closes nothing, fewer sessions are started
- **And** an emptied effort, repository model, repository auto-merge mode or Extra instructions removes its key from the file, so the global value or none applies
- **And** the file is replaced in one step (never left half written), keeps its keys in their order, its `"$schema"` and everything else it had, and stays readable for hand edits (two-space indented JSON)
- **And** an invalid value shows the error next to the form, keeps the entered values, and nothing is saved
- **And** no other file holds settings: there is no overrides file, and a field doesn't show another value to go back to

### REQ-007-06 A hand edit applies while the Coordinator runs

- **Given** the Coordinator running
- **When** the Owner edits the config file by hand with a valid change to a setting the Config page can change
- **Then** the Coordinator uses it from its next tick on, like a save on the Config page; the file is also read every few seconds while waiting for that tick, so the Config page shows the change and a shorter `pollIntervalSec` shortens the wait in progress
- **And** an invalid edit (not JSON, or breaking a rule) is logged with the reason and ignored: the last valid config stays in use
- **And** a save on the Config page starts from the file as it is on disk, so it never loses a hand edit; while the file on disk is invalid, the save is refused with the reason and the file is left as it is

### REQ-007-07 Some settings need a restart

- **Given** the config file changed on disk while the Coordinator runs
- **When** the change touches repositories (which ones, their `setup`), Accounts, `owner`, `github`, `dashboard` or `stateDir`
- **Then** the Coordinator keeps the values it started with until it is restarted, and the Config page says which of them changed in the file and need a restart (`coordinator service restart`)

### REQ-007-08 `coordinator init` writes the config

- **Given** a machine with the prerequisites and no config yet
- **When** the Owner runs `coordinator init` and answers its questions
- **Then** it checks the GitHub CLI's login, and without one explains the fine-grained PAT's settings and logs in with a token the Owner pastes (hidden)
- **And** it takes the Owner's login and numeric id from the logged-in account, to confirm, so nobody looks an id up
- **And** the Owner picks the repositories from those the token can see, each with a `setup` command whose default is guessed from the repository's lockfile (e.g. `bun install` for `bun.lock`), or none
- **And** the Owner picks the model and effort per Role, the current defaults preselected
- **And** the dashboard is off, or on with "Sign in with GitHub": `init` prints the exact Homepage URL and callback URL to register in a GitHub OAuth App, then asks for its client id and, hidden, its client secret
- **And** optionally a dashboard token is generated; optionally extra Claude Code Accounts are added, each with the `CLAUDE_CONFIG_DIR=… claude` then `/login` step to run printed
- **And** the Owner picks the auto-merge mode: `off`, `evaluated` or `all`
- **Then** it writes a valid config file at the config location (REQ-007-02) with a `"$schema"` pointing at the installed `config.schema.json`, runs the setup check, and offers to install the service (REQ-007-11)
- **And** cancelling at any question (Ctrl-C) writes nothing

### REQ-007-09 `init` on an existing config

- **Given** a config file at the config location
- **When** the Owner runs `coordinator init`
- **Then** it asks whether to edit the existing values, start over, or stop; nothing is overwritten without that answer
- **And** editing asks the same questions with the file's current values preselected (repositories, `setup` commands, models, effort, dashboard, auto-merge) and keeps the keys `init` doesn't ask about, e.g. `limits` and Extra instructions

### REQ-007-10 Secrets are files only the user can read

- **Given** a client secret or a dashboard token from `init`
- **When** it is written
- **Then** it goes into a file in the state folder that only the user can read and write (mode 600), and the config holds only the file's path, never the secret
- **And** editing an existing config keeps the existing secret file unless the Owner enters a new secret

### REQ-007-11 `coordinator service` manages the systemd service

- **Given** the Coordinator installed
- **When** the Owner runs `coordinator service install`
- **Then** it writes `/etc/systemd/system/github-issue-coordinator.service`, made from the actual environment: the path of `bun`, the installed package's entry point, the config path in use, the user running it, and a `PATH` with the folders of `bun` and `claude`, `~/.local/bin` and `~/.bun/bin`
- **And** the unit keeps agent sessions running when the service stops or restarts (only the Coordinator's own process is stopped) and restarts the Coordinator when it fails
- **And** it reloads systemd and enables and starts the service
- **And** `uninstall` stops and disables the service and removes the unit; `status`, `logs` (followed) and `restart` act on the service
- **And** a systemd call that fails stops the command with its error and a non-zero exit code

### REQ-007-12 The version is shown

- **Given** the installed package
- **When** the Owner runs `coordinator --version` or `coordinator doctor`, or opens the Config page
- **Then** each shows the package's version
- **And** `doctor` says when a newer version is on npm, with the command to update; when npm can't be reached it says so as a warning, never a problem to fix

### REQ-007-13 A release is merging the release PR

- **Given** `feat:` and `fix:` PRs merged into `main` since the last release
- **When** release-please runs on `main`
- **Then** one release PR proposes the next version (`fix:` a patch, `feat:` a minor, a breaking change a major; below 1.0 a breaking change bumps the minor) in `package.json` and the release manifest, with those PRs in `CHANGELOG.md`
- **And** `docs:`, `ci:`, `chore:` and `test:` PRs open no release PR
- **When** the Owner merges the release PR
- **Then** the `vX.Y.Z` tag and the GitHub Release are created, lint and tests run on the tag, and the version is published to npm with provenance, through npm trusted publishing (no npm token)
- **And** the release PR's checks run, since it is opened with a token that triggers workflows

### REQ-007-14 PR titles are conventional

- **Given** a pull request
- **When** its title isn't a Conventional Commit (e.g. `feat: …`, `fix(dashboard): …`, `feat!: …`)
- **Then** a CI check fails, since squash-merge titles make the versions and the changelog
- **And** the Implementer is told to title its PR that way and to mark a breaking change with `!`; the Reviewer rates a PR that changes the version, the release manifest or the release workflow as high risk

### REQ-007-15 The package ships what it runs

- **Given** the published package
- **When** it runs from the global install, without a checkout
- **Then** it has the source, the Role prompts, the hook, the dashboard's assets and styles and `config.schema.json`, and no tests, docs or fixtures

## Out of scope

- Migrating `config.ts`: there is one user, who runs `coordinator init` once.
- Setting up the repository rulesets (docs/setup.md step 2): they stay manual; `doctor` keeps reminding.
- Logging in the extra Accounts: `init` prints the command, the Owner runs it.
- Other init systems than systemd, and running as a user service.
- Picking up a restart-only change without a restart (REQ-007-07).
- Relative paths other than `stateDir` (an Account's `configDir`, `tokenPath`, `clientSecretPath`): `init` writes absolute ones.

## Assumptions

- Bun stays a prerequisite, with tmux, git, `gh` and Claude Code; the package runs its TypeScript with Bun, without a build step.
- The package name `github-issue-coordinator` is free on npm.
- The machine runs systemd and `coordinator service` is run as root (or with `sudo`), like the documented setup.
- A one-time maintainer setup: this repository's `release.yml` registered as the package's trusted publisher on npmjs.com, a small GitHub App (Contents and Pull requests write, this repository only) whose id and key are the `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` secrets, so release-please's PR triggers CI.
- The first release is `0.1.0`.

## Verification

| REQ        | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Result |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| REQ-007-01 | `coordinator command > REQ-007-01 …` (3 tests: the config path from `--config` before or after the command, `$COORDINATOR_CONFIG` or the default; the exit code; `--version`, `--help`, no or an unknown command); `package > REQ-007-01 / REQ-007-15 …` (`bin`); manual: the packed package installed with `bun add -g` into a temp prefix runs `coordinator --version`, the usage and `coordinator start`                                                                                                                                                                                                                                                            | pass   |
| REQ-007-02 | `locations > REQ-007-02 …`; `config > REQ-007-02 …` (2 tests: a JSON file with `$schema`; a missing file, a `.ts`/`.js` config, a file that isn't JSON); `config file > REQ-007-02 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | pass   |
| REQ-007-03 | `locations > REQ-007-03 …`; `config > REQ-007-03 …` (2 tests: relative to the config file; `$XDG_DATA_HOME`); manual: `coordinator start` from the installed package wrote `state.db` into `$XDG_DATA_HOME/github-issue-coordinator/` and nothing into the working folder                                                                                                                                                                                                                                                                                                                                                                                              | pass   |
| REQ-007-04 | `config.schema.json > REQ-007-04 …` (2 tests: the shipped file is the generated one; keys, `$schema`, no unknown keys)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | pass   |
| REQ-007-05 | `config file > REQ-007-05 …` (3 tests: written into the file keeping key order, `$schema` and other keys, two-space JSON, no temp or other file; every editable key with `null` removing a key and an emptied block; refused changes outside the allow-list or invalid leave the file as it is) and `… a change for a repository that isn't in the file is ignored`; `dashboard settings > REQ-007-05 …` (5 tests incl. the form, saving into the file without Reset or a `config.ts` value, `autoMerge`, an invalid value saves nothing); `REQ-003-40`/`REQ-003-44` dashboard tests now check the file; `reconcile loop … > REQ-007-05 …`; `worktrees > REQ-007-05 …` | pass   |
| REQ-007-06 | `hand edits while running > REQ-007-06 …` (3 tests: a valid edit applies on the next reload; an invalid one is logged once and ignored; a save keeps a hand edit and is refused while the file is invalid); `dashboard settings > REQ-007-06 …`; manual: a hand edit of the installed package's config showed on the Config page within 7 s                                                                                                                                                                                                                                                                                                                            | pass   |
| REQ-007-07 | `restart-only settings > REQ-007-07 …` (2 tests); `dashboard settings > REQ-007-07 / REQ-007-12 …`; screenshot on the PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass   |
| REQ-007-08 | `coordinator init > REQ-007-08 …` (6 tests: a fresh setup with defaults preselected and the OAuth URLs; the PAT and `gh auth login` with a retry; another Owner by login; dashboard off; cancelling writes nothing, declining the service; setup guessed from the lockfile). Not run: the `@clack/prompts` terminal itself (no TTY here)                                                                                                                                                                                                                                                                                                                               | pass   |
| REQ-007-09 | `coordinator init on an existing config > REQ-007-09 …` (3 tests: Stop changes nothing; Edit preselects and keeps other keys; a non-JSON file can only be replaced)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass   |
| REQ-007-10 | `coordinator init > REQ-007-10 …` (2 tests: secrets as mode-600 files, paths in the config; the machine's write with mode 600 in a 700 folder); `… on an existing config > REQ-007-10 …`; `REQ-007-09 editing …` keeps the old secret file                                                                                                                                                                                                                                                                                                                                                                                                                             | pass   |
| REQ-007-11 | `coordinator service > REQ-007-11 …` (5 tests: the unit's contents; other paths and quoting; install; no config, no root, failing systemctl; uninstall, status, logs, restart). Not run: a real `systemctl` install (no systemd in this sandbox)                                                                                                                                                                                                                                                                                                                                                                                                                       | pass   |
| REQ-007-12 | `version > REQ-007-12 …` (2 tests); `doctor's version check > REQ-007-12 …` (2 tests); `coordinator command > REQ-007-01 / REQ-007-12 …`; `dashboard settings > REQ-007-07 / REQ-007-12 …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass   |
| REQ-007-13 | `releases > REQ-007-13 …` (2 tests: release-please config and manifest; `release.yml` jobs, App token, OIDC publish without an npm token). Not run: release-please and `npm publish` themselves (need the one-time setup in docs/setup.md)                                                                                                                                                                                                                                                                                                                                                                                                                             | pass   |
| REQ-007-14 | `releases > REQ-007-14 …` (the PR title check, pinned, and the prompts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass   |
| REQ-007-15 | `package > REQ-007-01 / REQ-007-15 …` (`bun pm pack` lists the source, prompts, hook, dashboard assets and styles, `config.schema.json`, and no tests, docs or scripts); manual: the dashboard rendered from the global install                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass   |
