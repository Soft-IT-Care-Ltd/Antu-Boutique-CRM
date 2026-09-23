import { afterEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, maskSecret, timingSafeEqual } from "@/lib/courier/crypto";

// PRD §4.9: courier credentials encrypted with COURIER_ENCRYPTION_KEY.
describe("courier secret encryption", () => {
  const original = process.env.COURIER_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.COURIER_ENCRYPTION_KEY = original;
  });

  it("round-trips, and the ciphertext never contains the plaintext", () => {
    process.env.COURIER_ENCRYPTION_KEY = "a".repeat(64);
    const cipher = encryptSecret("sf-api-key-123456");
    expect(cipher).not.toContain("sf-api-key");
    expect(decryptSecret(cipher)).toBe("sf-api-key-123456");
    // Fresh IV each time.
    expect(encryptSecret("sf-api-key-123456")).not.toBe(cipher);
  });

  it("rejects tampered ciphertext and a different key", () => {
    process.env.COURIER_ENCRYPTION_KEY = "b".repeat(64);
    const [iv, tag, data] = encryptSecret("secret-value").split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptSecret(`${iv}:${tag}:${flipped.toString("base64")}`)).toThrow();
    const cipher = encryptSecret("secret-value");
    process.env.COURIER_ENCRYPTION_KEY = "c".repeat(64);
    expect(() => decryptSecret(cipher)).toThrow();
  });

  it("refuses to run without COURIER_ENCRYPTION_KEY — no silent fallback", () => {
    process.env.COURIER_ENCRYPTION_KEY = " ";
    expect(() => encryptSecret("x")).toThrow(/COURIER_ENCRYPTION_KEY/);
  });

  it("masks and compares safely", () => {
    expect(maskSecret("abcdefghij")).toBe("****…hij");
    expect(maskSecret("abc")).toBe("****");
    expect(timingSafeEqual("same", "same")).toBe(true);
    expect(timingSafeEqual("same", "diff")).toBe(false);
    expect(timingSafeEqual("short", "longer-string")).toBe(false);
  });
});
