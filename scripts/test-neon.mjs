// `npm run test:neon` — the full test suite against Neon's antu_test
// instead of the local Postgres 18 one. Run it before every deploy: dev and
// production run on Neon, so this proves the code against Neon itself
// (network round-trips, the pooler, Neon's Postgres build).
//
// It only swaps TEST_DATABASE_URL for NEON_TEST_DATABASE_URL; every guard
// in lib/test/test-db.ts still applies (the name must end in _test and be
// none of DATABASE_URL / DIRECT_URL / SHADOW_DATABASE_URL).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(root, ".env"), quiet: true });

const neon = process.env.NEON_TEST_DATABASE_URL;
if (!neon) {
  console.error("NEON_TEST_DATABASE_URL is not set — add Neon's antu_test URL to .env (SETUP.md §4).");
  process.exit(1);
}
const result = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TEST_DATABASE_URL: neon },
});
process.exit(result.status ?? 1);
