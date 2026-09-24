import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";

import { resolveTestDatabaseUrl } from "./test-db";

// Runs once before the integration project. Brings antu_test up to date:
// applies pending migrations (`migrate deploy` never resets anything) and
// re-runs the upsert-based seed when the schema, migrations or seed changed.
// Nothing here ever touches DATABASE_URL / DIRECT_URL.

const root = path.resolve(__dirname, "../..");

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * A migration edited after antu_test applied it (e.g. while it was being
 * drafted) leaves the test schema silently different from what the files
 * say — `migrate deploy` doesn't notice. Refuse to run on top of that.
 */
async function assertAppliedMigrationsUnchanged(prisma: PrismaClient): Promise<void> {
  const applied = await prisma.$queryRawUnsafe<{ migration_name: string; checksum: string }[]>(
    `SELECT "migration_name", "checksum" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
  ).catch(() => []);
  const changed = applied.filter((m) => {
    try {
      return sha256(readFileSync(path.join(root, "prisma/migrations", m.migration_name, "migration.sql"))) !== m.checksum;
    } catch {
      return true; // applied to antu_test but no longer in the repo
    }
  });
  if (changed.length > 0) {
    throw new Error(
      `antu_test has migrations applied that no longer match prisma/migrations: ${changed.map((m) => m.migration_name).join(", ")}. ` +
        "Rebuild the test database (SETUP.md §4 — drop and re-create antu_test) and run the tests again.",
    );
  }
}

function fingerprint(): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path.join(root, "prisma/schema.prisma")));
  hash.update(readFileSync(path.join(root, "prisma/seed.ts")));
  // The seed syncs every role's permissions from these templates.
  hash.update(readFileSync(path.join(root, "lib/auth/permission-definitions.ts")));
  for (const dir of readdirSync(path.join(root, "prisma/migrations")).sort()) hash.update(dir);
  return hash.digest("hex");
}

export default async function setup() {
  config({ path: path.join(root, ".env"), quiet: true });
  const url = resolveTestDatabaseUrl();
  // Child processes get the test URL; this process's env is left alone so
  // each worker's guard can still compare against the real dev URLs.
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url, SHADOW_DATABASE_URL: "" };
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await assertAppliedMigrationsUnchanged(prisma);
    run("npx", ["prisma", "migrate", "deploy"]);

    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_test_seed_state" ("id" INT PRIMARY KEY, "hash" TEXT NOT NULL)`);
    const [row] = await prisma.$queryRawUnsafe<{ hash: string }[]>(`SELECT "hash" FROM "_test_seed_state" WHERE "id" = 1`);
    const want = fingerprint();
    if (row?.hash !== want) {
      run("npx", ["tsx", "--conditions=react-server", "prisma/seed.ts"]);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "_test_seed_state" ("id", "hash") VALUES (1, $1) ON CONFLICT ("id") DO UPDATE SET "hash" = EXCLUDED."hash"`,
        want,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}
