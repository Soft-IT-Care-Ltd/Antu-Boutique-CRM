import crypto from "crypto";

// ============ Encryption at rest (STEADFAST_INTEGRATION.md §5) ============
//
// Steadfast API key/secret and the inbound webhook token are stored encrypted;
// they are only ever decrypted server-side to talk to the courier or to
// authenticate an incoming webhook (§1 / §3A / §5). AES-256-GCM gives us
// confidentiality + an auth tag so tampering is detectable.
//
// The 32-byte key is derived (SHA-256) from COURIER_ENCRYPTION_KEY, falling back
// to NEXTAUTH_SECRET so the feature works with the existing env. Set a dedicated
// COURIER_ENCRYPTION_KEY in production (see .env.example). Deriving by hash means
// the master secret itself is never stored and the derived key is a fixed 32 bytes.

const ALGO = "aes-256-gcm";

function encryptionKey(): Buffer {
  const secret =
    process.env.COURIER_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "No encryption secret: set COURIER_ENCRYPTION_KEY (or NEXTAUTH_SECRET)"
    );
  }
  return crypto.createHash("sha256").update(secret).digest();
}

// Serialized as base64 parts iv:tag:ciphertext so a single string round-trips
// through one DB column.
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12); // 96-bit nonce, GCM standard
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted value");
  }
  const decipher = crypto.createDecipheriv(
    ALGO,
    encryptionKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

// A URL-safe random token for the webhook Bearer secret (§3A). 32 bytes → 43
// base64url chars, comfortably over the "32+ chars" requirement.
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Constant-time compare so the webhook auth check can't be probed by timing
// (§3A Bearer auth). Length-mismatch returns false without leaking via timing.
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Show a saved key as ****…abc (§1 "never sent to client after save").
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 4) return "****";
  return `****…${plaintext.slice(-3)}`;
}
