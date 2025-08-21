// Normalize to digits-only (strip +, spaces, dashes, parentheses)
export function normalizePhone(raw: string): string {
  if (!raw) return "";
  // turn 00.. into +.. to standardize before stripping non-digits
  const s = raw.trim().replace(/^00/, "+");
  const digits = s.replace(/\D+/g, "");
  return digits;
}

// Generate candidate representations for searching in GHL
// e.g. local 8-digit HK, with country code (852...), with 00 prefix, etc.
export function candidatePhones(input: string, defaultCountryCode?: string): string[] {
  const dcc = (defaultCountryCode || "").replace(/\D+/g, "");
  const digits = normalizePhone(input);

  const out = new Set<string>();
  if (!digits) return [];

  // If number already includes a country code (11-15 digits), keep it
  out.add(digits);

  // Try E.164 with default country code (if local-like)
  if (dcc && digits.length <= 10) {
    out.add(`${dcc}${digits}`);
    out.add(`00${dcc}${digits}`);
  }

  // Also keep raw local digits (often stored that way)
  if (digits.length >= 6 && digits.length <= 12) {
    out.add(digits);
  }

  return Array.from(out);
}
