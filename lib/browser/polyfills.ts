// Runtime APIs the client bundles call that iOS Safari 15.0–15.3 lacks
// (P3.0, Gift Valy CORRECTIONS Round 2 §2.8). The browserslist in
// package.json makes the compiler lower new *syntax*; it never adds missing
// *functions*, so the ones found in the built bundles are filled here:
// Array/String .at() (Next's router), Object.hasOwn (base-ui forms) and
// findLast/findLastIndex. Loaded by instrumentation-client.ts before React
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

export {};
