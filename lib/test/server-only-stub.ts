// vitest runs in plain Node, without the webpack/turbopack substitution
// that makes the real `server-only` package a no-op on the server build.
// This stub stands in for it under test — see vitest.config.ts alias.
export {};
