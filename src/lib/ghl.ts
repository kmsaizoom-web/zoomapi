// Helpers to fetch a GHL contact strictly by core contact.phone (HK-friendly normalization)
// and to read the custom field {{ contact.zoom_display_name }} as the display name.

type Json = Record<string, unknown>;

export interface GhlCustomKV {
  id: string;
  value: unknown;
}
export interface GhlContact {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  customField?: GhlCustomKV[];   // some accounts
  customFields?: GhlCustomKV[];  // other accounts
  [k: string]: unknown;
}
interface ContactsShape {
  contacts?: GhlContact[];
  items?: GhlContact[];
  data?: GhlContact[];
  [k: string]: unknown;
}

const REQUIRED_ENV = ["GHL_API_KEY"] as const;
function reqEnv(name: (typeof REQUIRED_ENV)[number]): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

const DEFAULT_BASES = [
  process.env.GHL_BASE_URL?.replace(/\/+$/, "") || "https://rest.gohighlevel.com",
  "https://services.leadconnectorhq.com",
] as const;

function toQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function ghlGet(path: string, params: Record<string, string | number | undefined>): Promise<Json> {
  const token = reqEnv("GHL_API_KEY");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const qs = toQuery(params);
  const errors: string[] = [];

  for (const base of DEFAULT_BASES) {
    const url = `${base}${path}${qs}`;
    try {
      const r = await fetch(url, { headers, cache: "no-store" });
      const text = await r.text();
      if (r.ok) {
        if (!text) return {};
        try { return JSON.parse(text) as Json; }
        catch { return { _raw_text: text } as Json; }
      } else {
        if (r.status === 429) {
          const ra = r.headers.get("Retry-After");
          if (ra) {
            const ms = Math.max(0, Number(ra) * 1000);
            if (ms) await new Promise(res => setTimeout(res, ms));
          }
        }
        errors.push(`${base} -> ${r.status} ${text || ""}`);
      }
    } catch (e) {
      errors.push(`${base} -> ${String(e)}`);
    }
  }
  throw new Error(`All GHL bases failed for ${path}${qs}\n${errors.join("\n")}`);
}

function pickContactsArray(data: Json): GhlContact[] {
  const d = data as ContactsShape;
  if (Array.isArray(d.contacts)) return d.contacts;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.data)) return d.data;
  for (const v of Object.values(d)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v as GhlContact[];
  }
  return [];
}

// -------- Phone normalization (HK-centric but safe elsewhere) --------
function normalizeToE164HK(input: string): string {
  let s = (input || "").trim();
  if (!s) return s;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (s.startsWith("+")) return s.replace(/[^\d+]/g, "");
  const digits = s.replace(/\D/g, "");
  if (!digits) return s;
  if (/^\d{8}$/.test(digits)) return `+852${digits}`;   // HK local
  if (/^852\d{8}$/.test(digits)) return `+${digits}`;   // HK with 852
  return `+${digits}`;                                   // generic
}

function unique<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of arr) {
    const k = JSON.stringify(v);
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}
function buildPhoneSearchVariants(raw: string): string[] {
  const e164 = normalizeToE164HK(raw);
  const digits = raw.replace(/\D/g, "");
  const cands: string[] = [e164];
  if (e164.startsWith("+")) cands.push(e164.slice(1));
  if (digits && digits !== e164.replace(/\D/g, "")) cands.push(digits);
  if (/^\d{8}$/.test(digits)) cands.push(`852${digits}`);
  return unique(cands).filter(Boolean);
}

// Only accept rows whose **core contact.phone** === normalized target
async function findByCorePhoneStrict(targetRaw: string): Promise<GhlContact | null> {
  const normalizedTarget = normalizeToE164HK(targetRaw);
  if (!normalizedTarget) return null;

  const queries = buildPhoneSearchVariants(targetRaw);
  const limitPerPage = 25;
  const maxPagesPerQuery = 2;

  for (const q of queries) {
    for (let page = 1; page <= maxPagesPerQuery; page++) {
      const data = await ghlGet("/v1/contacts/", { query: q, limit: limitPerPage, page });
      const arr = pickContactsArray(data);
      if (!arr.length) break;

      for (const c of arr) {
        const phone = typeof c.phone === "string" ? c.phone : "";
        const norm = phone ? normalizeToE164HK(phone) : "";
        if (norm && norm === normalizedTarget) return c;
      }
      if (arr.length < limitPerPage) break;
    }
  }
  return null;
}

export async function findContactByPhone(phoneRaw: string): Promise<GhlContact | null> {
  if (!phoneRaw || !phoneRaw.trim()) return null;
  try { return await findByCorePhoneStrict(phoneRaw.trim()); } catch { return null; }
}

// -------- Custom field helpers --------
const cfKeyToIdCache = new Map<string, string | null>();

async function getCustomFieldIdByKey(fieldKey: string): Promise<string | null> {
  if (cfKeyToIdCache.has(fieldKey)) return cfKeyToIdCache.get(fieldKey)!;

  let page = 1;
  const limit = 200;
  let found: string | null = null;

  while (page <= 30) {
    const data = await ghlGet("/v1/custom-fields/", { limit, page });
    const arr =
      (Array.isArray((data as any)?.customFields) ? (data as any).customFields
      : Array.isArray((data as any)?.fields) ? (data as any).fields
      : Array.isArray((data as any)?.data) ? (data as any).data
      : []) as Array<{ id?: string; name?: string; fieldKey?: string }>;
    if (!arr.length) break;

    for (const f of arr) {
      const key = (f.fieldKey || f.name || "").toString();
      if (key === fieldKey) { found = f.id || null; break; }
    }
    if (found || arr.length < limit) break;
    page++;
  }

  cfKeyToIdCache.set(fieldKey, found);
  return found;
}

function valueToString(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) return val.map(valueToString).join(" ");
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    for (const key of ["label", "value", "name", "title"]) {
      if (typeof obj[key] === "string") return String(obj[key]);
    }
    try { return JSON.stringify(val); } catch { return ""; }
  }
  return "";
}

// Extract the value of {{ contact.zoom_display_name }} from a contact
export async function extractZoomDisplayName(contact: GhlContact): Promise<string | null> {
  const key = "contact.zoom_display_name";
  const id = await getCustomFieldIdByKey(key);
  const bags: (GhlCustomKV[] | undefined)[] = [contact.customField, contact.customFields];

  if (id) {
    for (const arr of bags) {
      if (!Array.isArray(arr)) continue;
      for (const cf of arr) {
        if (cf?.id === id) {
          const v = valueToString(cf.value).trim();
          if (v) return v;
        }
      }
    }
  }
  return null;
}
