import path from "node:path";
import { defineWorkspace } from "vitest/config";

const INTEGRATION = "**/*.integration.test.ts";

export default defineWorkspace([
  {
    // Pure logic: parallel, and no database at all.
    extends: "./vitest.config.ts",
    resolve: {
      alias: [{ find: /^@\/lib\/prisma$/, replacement: path.resolve(__dirname, "./lib/test/prisma-forbidden.ts") }],
    },
    test: {
      name: "unit",
      include: ["**/*.test.ts"],
      exclude: ["**/node_modules/**", INTEGRATION],
    },
  },
  {
    // Database tests: their own database (TEST_DATABASE_URL → antu_test),
    // one file at a time so no two suites contend for the same seeded rows.
    extends: "./vitest.config.ts",
    test: {
      name: "integration",
      include: [INTEGRATION],
      exclude: ["**/node_modules/**"],
      globalSetup: ["./lib/test/global-setup.ts"],
      setupFiles: ["./vitest.integration-setup.ts"],
      // One fork runs every integration file in turn. (`fileParallelism`
      // is a root-only option in vitest 2 and is ignored per project.)
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      // Per-test budget for round-trips to Neon (a read-only order-detail
      // test alone takes 2–9s). Not a Prisma transaction timeout: files run
      // serially, so nothing here waits on another suite's row lock.
      testTimeout: 30_000,
    },
  },
]);
