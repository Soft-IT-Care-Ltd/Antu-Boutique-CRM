// Bangladeshi mobile numbers only (PRD §4.4 has no country field/dropdown —
// this is a single-market boutique). Accepts a leading 0 or +880/880 and
// normalizes to the local 11-digit "01XXXXXXXXX" shape so "+8801711000004"
// and "01711000004" are recognised as the same phone at the unique index.

const BD_MOBILE_REGEX = /^(?:\+?880|0)1[3-9]\d{8}$/;

export function isValidBdPhone(input: string): boolean {
  return BD_MOBILE_REGEX.test(input.trim().replace(/[\s-]/g, ""));
}

export function normalizeBdPhone(input: string): string {
  const trimmed = input.trim().replace(/[\s-]/g, "");
  if (trimmed.startsWith("+880")) return `0${trimmed.slice(4)}`;
  if (trimmed.startsWith("880")) return `0${trimmed.slice(3)}`;
  return trimmed;
}
