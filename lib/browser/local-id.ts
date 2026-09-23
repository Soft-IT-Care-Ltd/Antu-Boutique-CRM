// An id for something that only lives in the browser until it's saved (an
// order line, a staged image). crypto.randomUUID can't be relied on: iOS
// Safari before 15.4 doesn't have it, and no browser offers it outside a
// secure context — e.g. the showroom iPad opening the app over plain http://
// on the shop's Wi-Fi. (P3.0, Gift Valy CORRECTIONS Round 2 §2.8.)

let counter = 0;

export function newLocalId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2)}`;
}
