// Integration tests run against their own throwaway database (antu_test),
// never the dev database. This is the one place that decides which URL the
// tests get, and it refuses anything that could be a real database.

type Env = Record<string, string | undefined>;

function dbIdentity(raw: string): string {
  const url = new URL(raw);
  // Neon's pooled and direct hosts reach the same database.
  const host = url.hostname.replace("-pooler.", ".");
  return `${host}:${url.port || "5432"}${url.pathname}`;
}

export function resolveTestDatabaseUrl(env: Env = process.env): string {
  const testUrl = env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is not set. Integration tests need their own database (antu_test) — see SETUP.md §4.");
  }
  let dbName: string;
  try {
    dbName = new URL(testUrl).pathname.replace(/^\//, "");
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL.");
  }
  if (!dbName.endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL points at "${dbName}". The test database's name must end in _test (e.g. antu_test).`);
  }
  const testId = dbIdentity(testUrl);
  for (const key of ["DATABASE_URL", "DIRECT_URL", "SHADOW_DATABASE_URL"] as const) {
    const other = env[key];
    if (other && dbIdentity(other) === testId) {
      throw new Error(`TEST_DATABASE_URL is the same database as ${key}. Refusing to run tests against it.`);
    }
  }
  return testUrl;
}

const APPLIED_MARKER = "ANTU_TEST_DATABASE_APPLIED";

/**
 * Points every Prisma connection in this process at the test database.
 * Integration files share one worker process, so this runs once per file:
 * the guard checks against the real dev URLs the first time, then marks the
 * process so later files don't mistake the swapped URLs for a collision.
 */
export function useTestDatabase(env: Env = process.env): string {
  const url = env[APPLIED_MARKER] && env[APPLIED_MARKER] === env.TEST_DATABASE_URL ? env[APPLIED_MARKER] : resolveTestDatabaseUrl(env);
  env.DATABASE_URL = url;
  env.DIRECT_URL = url;
  delete env.SHADOW_DATABASE_URL;
  env[APPLIED_MARKER] = url;
  return url;
}
