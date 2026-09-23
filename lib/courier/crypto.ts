import "server-only";

import crypto from "node:crypto";

// Courier secrets at rest (PRD §4.9): the Steadfast API key/secret and the
// inbound webhook token are AES-256-GCM ciphertext under
// COURIER_ENCRYPTION_KEY — confidentiality plus an auth tag, so a tampered
// value fails to decrypt instead of decrypting to garbage. No fallback to
// NEXTAUTH_SECRET: a missing key is a configuration error, loudly.

const ALGO = "aes-256-gcm";

function encryptionKey(): Buffer {
  const secret = process.env.COURIER_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("COURIER_ENCRYPTION_KEY is not set (generate one with: openssl rand -hex 32)");
  }
  // The documented format is 32 random bytes as hex; anything else is
  // stretched to 32 bytes with SHA-256.
  return /^[0-9a-f]{64}$/i.test(secret) ? Buffer.from(secret, "hex") : crypto.createHash("sha256").update(secret).digest();
}

/** iv:tag:ciphertext, base64 — one string, one column. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [iv, tag, data] = payload.split(":");
  if (!iv || !tag || !data) throw new Error("Malformed encrypted value");
  const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/** 32 random bytes, base64url — 43 chars, over Steadfast's "32+ chars" bar. */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Constant-time string compare (webhook + cron bearer checks). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** The only form a saved secret is ever shown in: ****…abc. */
export function maskSecret(plaintext: string): string {
  return plaintext.length <= 6 ? "****" : `****…${plaintext.slice(-3)}`;
}
