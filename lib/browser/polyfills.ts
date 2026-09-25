// Runtime APIs the client bundles call that iOS Safari 15.0–15.3 lacks
// (P3.0, Gift Valy CORRECTIONS Round 2 §2.8). The browserslist in
// package.json makes the compiler lower new *syntax*; it never adds missing
// *functions*, so the ones found in the built bundles are filled here:
// Array/String .at() (Next's router), Object.hasOwn (base-ui forms),
// findLast/findLastIndex and structuredClone (P4.3 — Recharts' es-toolkit). Loaded by instrumentation-client.ts before React
// hydrates. Each is defined only when missing, non-enumerable, like the
// built-in it stands in for.

function define(target: object, name: string, value: unknown) {
  if (!(name in target)) Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

function at<T>(this: ArrayLike<T>, index: number): T | undefined {
  const n = Math.trunc(index) || 0;
  const i = n < 0 ? this.length + n : n;
  return i < 0 || i >= this.length ? undefined : this[i];
}

define(Array.prototype, "at", at);
define(String.prototype, "at", function (this: string, index: number) {
  return at.call(String(this), index);
});

define(Object, "hasOwn", (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(Object(object), key));

define(Array.prototype, "findLastIndex", function <T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown) {
  for (let i = this.length - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return i;
  return -1;
});
define(Array.prototype, "findLast", function <T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown) {
  for (let i = this.length - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return this[i];
  return undefined;
});

// P4.3 — Recharts bundles es-toolkit, whose cloneDeep calls structuredClone
// only to copy an Error. Safari gained it in 15.4. This stand-in covers
// what can reach it here — Errors and plain data (objects, arrays, dates,
// maps, sets) — and throws like the real one on anything else (functions,
// DOM nodes), rather than guessing.
function cloneValue(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") throw new TypeError("structuredClone: value could not be cloned");
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Error) {
    const copy = new (value.constructor as ErrorConstructor)(value.message);
    seen.set(value, copy);
    copy.name = value.name;
    if (value.stack) copy.stack = value.stack;
    if ("cause" in value) Object.defineProperty(copy, "cause", { value: cloneValue((value as { cause?: unknown }).cause, seen), writable: true, configurable: true });
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    value.forEach((v, k) => copy.set(cloneValue(k, seen), cloneValue(v, seen)));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    value.forEach((v) => copy.add(cloneValue(v, seen)));
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    value.forEach((v, i) => (copy[i] = cloneValue(v, seen)));
    return copy;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError("structuredClone: value could not be cloned");
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = cloneValue((value as Record<string, unknown>)[key], seen);
  return copy;
}

define(globalThis, "structuredClone", <T>(value: T): T => cloneValue(value, new Map()) as T);

export {};
