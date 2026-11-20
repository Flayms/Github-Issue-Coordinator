/** Writes `config.schema.json` from the config rules (REQ-007-04): `bun run schema`. */
import { writeFileSync } from "node:fs";
import { configJsonSchema } from "../src/config.ts";
import { CONFIG_SCHEMA_PATH } from "../src/version.ts";

writeFileSync(CONFIG_SCHEMA_PATH, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.log(`wrote ${CONFIG_SCHEMA_PATH}`);
