// Checks the built client bundles for anything iOS Safari 15 can't run
// (P3.0, Gift Valy CORRECTIONS Round 2 §2.8 — one unparseable chunk left
// every iPhone on a blank page). Run after `npm run build`:
//
//   npm run check:ios
//
// 1. SYNTAX: every chunk must parse as ES2022, with no class static block,
//    regex lookbehind or regex /v flag (Safari < 16.4 throws a SyntaxError
//    and the whole chunk dies). The browserslist in package.json lowers
//    syntax; this proves it did, including inside node_modules.
// 2. APIS: calls to runtime functions iOS 15.0 lacks must be covered by
//    lib/browser/polyfills.ts, or be feature-tested at the call site.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parse } from "acorn";

const root = process.argv[2] ?? ".next/static/chunks";

// Filled by lib/browser/polyfills.ts, so a call is fine.
const POLYFILLED = {
  "Array/String .at()": /\.at\((?!\s*\))/g,
  "Object.hasOwn": /Object\.hasOwn\s*\(/g,
  "findLast/findLastIndex": /\.findLast(?:Index)?\s*\(/g,
  // P4.3 — Errors and plain data only (Recharts' es-toolkit clones an Error with it).
  structuredClone: /\bstructuredClone\s*\(/g,
};
// Not polyfilled: a call must sit next to a typeof check for the same name.
const GUARDED = { "crypto.randomUUID": /\.randomUUID\s*\(/g };
// Not polyfilled and not guardable here: any call fails the check.
const FORBIDDEN = {
  "toSorted/toReversed/toSpliced": /\.(?:toSorted|toReversed|toSpliced)\s*\(/g,
  "Object.groupBy/Map.groupBy": /\b(?:Object|Map)\.groupBy\s*\(/g,
  "Promise.withResolvers": /Promise\.withResolvers\s*\(/g,
  "Array.fromAsync": /Array\.fromAsync\s*\(/g,
};

function files(dir) {
  return readdirSync(dir).flatMap((e) => {
    const f = path.join(dir, e);
    return statSync(f).isDirectory() ? files(f) : f.endsWith(".js") ? [f] : [];
  });
}

function syntaxProblems(src) {
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 2022, sourceType: "script", allowHashBang: true });
  } catch {
    try {
      ast = parse(src, { ecmaVersion: 2022, sourceType: "module" });
    } catch (e) {
      return [`not valid ES2022: ${e.message}`];
    }
  }
  const found = new Set();
  (function visit(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "StaticBlock") found.add("class static block");
    if (n.type === "Literal" && n.regex) {
      if (/\(\?<[=!]/.test(n.regex.pattern)) found.add(`regex lookbehind /${n.regex.pattern.slice(0, 40)}/`);
      if (n.regex.flags.includes("v")) found.add("regex v flag");
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  })(ast);
  return [...found];
}

const all = files(root);
if (all.length === 0) {
  console.error(`No .js files under ${root} — run \`npm run build\` first.`);
  process.exit(2);
}

const failures = [];
const polyfilledUse = {};
for (const f of all) {
  const name = path.relative(root, f);
  const src = readFileSync(f, "utf8");
  for (const p of syntaxProblems(src)) failures.push(`${name}: ${p}`);
  for (const [api, re] of Object.entries(POLYFILLED)) polyfilledUse[api] = (polyfilledUse[api] ?? 0) + (src.match(re)?.length ?? 0);
  for (const [api, re] of Object.entries(GUARDED)) {
    const fn = api.split(".").pop();
    for (const m of src.matchAll(re)) {
      if (!src.slice(Math.max(0, m.index - 120), m.index).includes(`typeof`) || !src.slice(Math.max(0, m.index - 120), m.index).includes(fn)) {
        failures.push(`${name}: unguarded ${api} … ${src.slice(Math.max(0, m.index - 50), m.index + 30)}`);
      }
    }
  }
  for (const [api, re] of Object.entries(FORBIDDEN)) {
    for (const m of src.matchAll(re)) failures.push(`${name}: ${api} … ${src.slice(Math.max(0, m.index - 50), m.index + 30)}`);
  }
}

console.log(`${all.length} client chunks checked for iOS Safari 15.`);
for (const [api, n] of Object.entries(polyfilledUse)) if (n) console.log(`  ${api}: ${n} call(s), covered by lib/browser/polyfills.ts`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("✓ No syntax or API iOS Safari 15 can't run.");
