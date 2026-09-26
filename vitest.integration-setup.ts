import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { useTestDatabase } from "@/lib/test/test-db";

// Runs in each integration worker after vitest.setup.ts has loaded .env and
// before any test imports Prisma: every connection goes to antu_test.
useTestDatabase();

// …and every upload goes to a throwaway folder, never the app's real
// uploads. Test orders share order numbers with dev orders (both sequences
// start at AB-2609-0001), so a test that wrote — or the trash purge that
// deletes — orders/<order_no> must not reach the dev photos.
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "antu-test-uploads-"));
