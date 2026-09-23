import { useTestDatabase } from "@/lib/test/test-db";

// Runs in each integration worker after vitest.setup.ts has loaded .env and
// before any test imports Prisma: every connection goes to antu_test.
useTestDatabase();
