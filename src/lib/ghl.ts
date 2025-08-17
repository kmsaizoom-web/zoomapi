import { normalizePhone } from "./phone";

const GHL_BASE = process.env.GHL_BASE_URL || "https://rest.gohighlevel.com";
const GHL_KEY = process.env.GHL_API_KEY;
const SCHOOL_FIELD_ID = process.env.GHL_SCHOOL_FIELD_ID;

if (!GHL_KEY) {
  console.warn("WARNING: GHL_API_KEY not set");
}

export type GhlCustomField = { id: string; value: string };
export type GhlContact = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  customFields?: GhlCustomField[];
};

export async function findContactByPhone(phoneRaw: string): Promise<GhlContact | null> {
  const phone = normalizePhone(phoneRaw);
  const url = `${GHL_BASE}/v1/contacts/?query=${encodeURIComponent(phone)}&limit=10`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${GHL_KEY}` },
    cache: "no-store",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GHL search failed: ${data?.message || res.status}`);
  }
  const items: GhlContact[] = data?.contacts || [];

  // Prefer exact normalized phone match
  const exact = items.find(c => normalizePhone(c.phone) === phone);
  return exact || items[0] || null;
}

export function extractSchoolName(contact: GhlContact): string | undefined {
  if (!SCHOOL_FIELD_ID) return undefined;
  return contact.customFields?.find(f => f.id === SCHOOL_FIELD_ID)?.value;
}
