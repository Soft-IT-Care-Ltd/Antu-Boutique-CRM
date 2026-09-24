// Product codes and SKUs for test fixtures. Codes are 2–3 characters and
// SKUs at most 9 (DB CHECKs, PRD §4.2), so fixtures can't use timestamps.
// "Q" + 2 characters: no seeded product starts with Q, and a file gets 1,024
// distinct codes (its rows are rolled back, so files never collide).

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let next = Math.floor(Math.random() * 1024);

export function testProductCode(): string {
  const n = next++ % 1024;
  return `Q${ALPHABET[Math.floor(n / 32)]}${ALPHABET[n % 32]}`;
}

/** A SKU no other fixture has: the (unique) product code plus a suffix. */
export function testSku(productCode: string, suffix = "T"): string {
  return `${productCode}${suffix}`;
}
