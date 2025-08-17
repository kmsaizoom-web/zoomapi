export function normalizePhone(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw.replace(/\D+/g, ""); // keep digits only
}
