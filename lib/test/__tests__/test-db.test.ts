import { describe, expect, it } from "vitest";

import { resolveTestDatabaseUrl, useTestDatabase } from "@/lib/test/test-db";

const DEV_POOLED = "postgresql://u:p@ep-x-pooler.c-4.aws.neon.tech/neondb?sslmode=require";
const DEV_DIRECT = "postgresql://u:p@ep-x.c-4.aws.neon.tech/neondb?sslmode=require";
const SHADOW = "postgresql://u:p@ep-x.c-4.aws.neon.tech/antu_shadow?sslmode=require";
const TEST = "postgresql://u:p@ep-x.c-4.aws.neon.tech/antu_test?sslmode=require";

describe("integration tests never reach a real database", () => {
  it("requires TEST_DATABASE_URL", () => {
    expect(() => resolveTestDatabaseUrl({ DATABASE_URL: DEV_POOLED })).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("requires a database name ending in _test", () => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: DEV_DIRECT })).toThrow(/must end in _test/);
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: SHADOW })).toThrow(/must end in _test/);
  });

  it("refuses a test URL that is the dev database, pooled or direct", () => {
    const sneaky = "postgresql://u:p@ep-x-pooler.c-4.aws.neon.tech/neondb_test";
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: sneaky, DIRECT_URL: "postgresql://u:p@ep-x.c-4.aws.neon.tech/neondb_test" })).toThrow(/same database as DIRECT_URL/);
  });

  it("points every connection at the test database", () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: TEST, DATABASE_URL: DEV_POOLED, DIRECT_URL: DEV_DIRECT, SHADOW_DATABASE_URL: SHADOW };
    useTestDatabase(env);
    expect(env).toMatchObject({ DATABASE_URL: TEST, DIRECT_URL: TEST });
    expect(env.SHADOW_DATABASE_URL).toBeUndefined();
  });

  it("can be applied again in the same process (integration files share one worker)", () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: TEST, DATABASE_URL: DEV_POOLED, DIRECT_URL: DEV_DIRECT };
    useTestDatabase(env);
    expect(() => useTestDatabase(env)).not.toThrow();
    expect(env.DATABASE_URL).toBe(TEST);
  });

  it("still refuses when TEST_DATABASE_URL changes after the first apply", () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: TEST, DATABASE_URL: DEV_POOLED, DIRECT_URL: DEV_DIRECT };
    useTestDatabase(env);
    env.TEST_DATABASE_URL = DEV_DIRECT;
    expect(() => useTestDatabase(env)).toThrow(/must end in _test/);
  });
});
