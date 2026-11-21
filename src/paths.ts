/**
 * Where the Coordinator keeps its files (spec 007): the config in the user's config folder, the state in the user's
 * data folder, both as the XDG Base Directory spec names them.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const APP_NAME = "issueflow";
export const CONFIG_FILE = "config.json";

type Env = Record<string, string | undefined>;

/** An XDG variable when it is an absolute path (the spec says to ignore a relative one), else the default. */
const xdg = (value: string | undefined, fallback: string) => (value && isAbsolute(value) ? value : fallback);

/** `$XDG_CONFIG_HOME/issueflow` (default `~/.config/…`). */
export const configDir = (env: Env = process.env) =>
  join(xdg(env.XDG_CONFIG_HOME, join(homedir(), ".config")), APP_NAME);

/** REQ-007-03: `$XDG_DATA_HOME/issueflow` (default `~/.local/share/…`). */
export const defaultStateDir = (env: Env = process.env) =>
  join(xdg(env.XDG_DATA_HOME, join(homedir(), ".local", "share")), APP_NAME);

/** REQ-007-02: the config file: `--config`, else `$ISSUEFLOW_CONFIG`, else the config folder's `config.json`; absolute. */
export const configPathOf = (flag: string | undefined, env: Env = process.env): string =>
  resolve(flag ?? env.ISSUEFLOW_CONFIG ?? join(configDir(env), CONFIG_FILE));
