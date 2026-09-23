// Stands in for `@/lib/prisma` in the unit-test project (vitest.workspace.ts).
// Unit tests run in parallel, so they must not touch the database: any test
// that does belongs in a *.integration.test.ts file, which runs serially
// against antu_test.

export const prisma = new Proxy({} as never, {
  get(_target, prop) {
    if (typeof prop === "symbol" || prop === "then") return undefined;
    throw new Error(`A unit test used prisma.${String(prop)}. Tests that touch the database must be named *.integration.test.ts.`);
  },
});
