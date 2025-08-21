// Helpers for GHL contact lookup and custom-field extraction (zoom_display_name)

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
  customFields?: GhlCustomKV[];  // others
  [k: string]: unknown;
}
type Json = Record<string, unknown>;

const GHL_API_KEY = process.env.GHL_API_KEY;
if (!GHL_API_KEY) throw new Error("Missing env GHL_API_KEY");

const BASES = [
  (process.env.GHL_BASE_URL || "https://rest.gohighlevel.com").replace(/\/+$/, ""),
  "https://services.leadconnectorhq.com"
];

function qs(params: Record<string, string | number | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

async function ghlGet(path: string, params: Record<string, string | number | undefined> = {}): Promise<Json> {
  const headers = { Authorization: `Bearer ${GHL_API_KEY}`, Accept: "application/json" };
  const query = qs(params);
  const errs: string[] = [];
  for (const base of BASES) {
    try {
      const r = await fetch(`${base}${path}${query}`, { headers, cache: "no-store" });
      const text = await r.text();
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw_text: text }; }
      if (r.ok) return data;
      if (r.status === 429) {
        const ra = r.headers.get("Retry-After");
        if (ra) await new Promise(res => setTimeout(res, Number(ra) * 1000));
      }
      errs.push(`${base} -> ${r.status}: ${text}`);
    } catch (e: any) {
      errs.push(`${base} -> ${String(e)}`);
    }
  }
  throw new Error(`All GHL hosts failed for ${path}${query}\n` + errs.join("\n"));
}

function pickContactsArray(data: Json): GhlContact[] {
  const d: any = data;
  if (Array.isArray(d.contacts)) return d.contacts;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.data)) return d.data;
  for (const v of Object.values(d)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v as GhlContact[];
  }
  return [];
}

// ---- phone normalization (HK friendly) ----
function normalizeE164HK(input: string): string {
  let s = (input || "").trim();
  if (!s) return s;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (s.startsWith("+")) return s.replace(/[^\d+]/g, "");
  const digits = s.replace(/\D/g, "");
  if (/^\d{8}$/.test(digits)) return `+852${digits}`;
  if (/^852\d{8}$/.test(digits)) return `+${digits}`;
  return `+${digits}`;
}
function uniq<T>(arr: T[]): T[] {
  const seen = new Set<string>(); const out: T[] = [];
  for (const v of arr) { const k = JSON.stringify(v); if (!seen.has(k)) { seen.add(k); out.push(v); } }
  return out;
}
function phoneCandidates(raw: string): string[] {
  const e164 = normalizeE164HK(raw);
  const digits = raw.replace(/\D/g, "");
  const cands = [e164];
  if (e164.startsWith("+")) cands.push(e164.slice(1));
  if (/^\d{8}$/.test(digits)) cands.push(`852${digits}`, digits);
  else cands.push(digits);
  return uniq(cands).filter(Boolean);
}

// Search and only accept where core contact.phone matches normalized target
async function findByCorePhoneStrict(raw: string): Promise<GhlContact | null> {
  const target = normalizeE164HK(raw);
  if (!target) return null;
  const queries = phoneCandidates(raw);
  const limit = 25;
  const maxPages = 2;

  for (const q of queries) {
    for (let page = 1; page <= maxPages; page++) {
      const data = await ghlGet("/v1/contacts/", { query: q, limit, page });
      const arr = pickContactsArray(data);
      if (!arr.length) break;
      for (const c of arr) {
        const p = typeof c.phone === "string" ? c.phone : "";
        if (p && normalizeE164HK(p) === target) return c;
      }
      if (arr.length < limit) break;
    }
  }
  return null;
}

export async function findContactByPhone(phoneRaw: string): Promise<GhlContact | null> {
  if (!phoneRaw || !phoneRaw.trim()) return null;
  try { return await findByCorePhoneStrict(phoneRaw.trim()); } catch { return null; }
}

// ---- zoom_display_name custom field resolution ----
function valueToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(valueToString).join(" ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["label", "value", "name", "title"]) if (typeof o[k] === "string") return String(o[k]);
    try { return JSON.stringify(v); } catch { return ""; }
  }
  return "";
}

const cfKeyCache = new Map<string, string | null>();

export async function getCustomFieldIdByKey(fieldKey: string): Promise<string | null> {
  if (cfKeyCache.has(fieldKey)) return cfKeyCache.get(fieldKey)!;
  let page = 1; const limit = 200; let found: string | null = null;
  while (page <= 40) {
    const data: any = await ghlGet("/v1/custom-fields/", { limit, page });
    const arr: any[] = Array.isArray(data?.customFields) ? data.customFields
                   : Array.isArray(data?.fields) ? data.fields
                   : Array.isArray(data?.data) ? data.data : [];
    if (!arr.length) break;
    for (const f of arr) {
      const key = String(f.fieldKey || f.name || "");
      if (key === fieldKey) { found = f.id || null; break; }
    }
    if (found || arr.length < limit) break;
    page++;
  }
  cfKeyCache.set(fieldKey, found);
  return found;
}

export async function extractZoomDisplayName(contact: GhlContact): Promise<string | null> {
  const key = "contact.zoom_display_name";
  const id = await getCustomFieldIdByKey(key);
  const lists = [contact.customField, contact.customFields];
  if (id) {
    for (const arr of lists) {
      if (!Array.isArray(arr)) continue;
      for (const kv of arr) {
        if (!kv || !kv.id) continue;
        if (kv.id === id) {
          const s = valueToString(kv.value).trim();
          if (s) return s;
        }
      }
    }
  }
  return null;
}
