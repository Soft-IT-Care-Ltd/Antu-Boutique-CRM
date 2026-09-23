import { parse } from "acorn";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOOT_GUARD_SCRIPT } from "@/lib/browser/boot-guard";

// P3.0 (Gift Valy CORRECTIONS Round 2 §2.8): what old iOS Safari lacks is
// simulated here by removing the built-ins, then loading our fallbacks.

type Proto = Record<string, unknown>;
const natives: [object, string, PropertyDescriptor][] = [];
function remove(target: object, name: string) {
  natives.push([target, name, Object.getOwnPropertyDescriptor(target, name)!]);
  delete (target as Proto)[name];
}
afterEach(() => {
  for (const [target, name, d] of natives.splice(0)) Object.defineProperty(target, name, d);
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("polyfills for iOS Safari 15.0–15.3", () => {
  it("fill .at(), Object.hasOwn and findLast/findLastIndex when missing, non-enumerable, matching the built-ins", async () => {
    remove(Array.prototype, "at");
    remove(String.prototype, "at");
    remove(Object, "hasOwn");
    remove(Array.prototype, "findLast");
    remove(Array.prototype, "findLastIndex");
    expect(([] as unknown as Proto).at).toBeUndefined();

    await import("@/lib/browser/polyfills");

    const xs = [10, 20, 30];
    expect([xs.at(0), xs.at(-1), xs.at(-3), xs.at(3), xs.at(-4), xs.at(1.7)]).toEqual([10, 30, 10, undefined, undefined, 20]);
    expect("a;b;c;d".split(";").at(-2)).toBe("c"); // Next's router: digest.split(";").at(-2)
    expect("abc".at(-1)).toBe("c");
    expect(Object.hasOwn({ a: 1 }, "a")).toBe(true);
    expect(Object.hasOwn(Object.create({ a: 1 }), "a")).toBe(false);
    expect(xs.findLast((x) => x < 25)).toBe(20);
    expect(xs.findLastIndex((x) => x > 99)).toBe(-1);
    for (const k in []) throw new Error(`polyfill ${k} is enumerable`);
  });

  it("never replaces a built-in that exists", async () => {
    const native = Array.prototype.at;
    await import("@/lib/browser/polyfills");
    expect(Array.prototype.at).toBe(native);
  });
});

describe("newLocalId", () => {
  it("works without crypto.randomUUID (old iOS, or any browser over plain http://)", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (b: Uint8Array) => b.fill(7) });
    const { newLocalId } = await import("@/lib/browser/local-id");
    expect(newLocalId()).toBe("07".repeat(16));
    vi.stubGlobal("crypto", undefined);
    const a = newLocalId();
    const b = newLocalId();
    expect(a).not.toBe(b);
  });
});

describe("pre-boot guard", () => {
  it("is plain ES5, so it runs on any browser that can load the page", () => {
    expect(() => parse(BOOT_GUARD_SCRIPT, { ecmaVersion: 5 })).not.toThrow();
  });
});
