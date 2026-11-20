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
  customField?: GhlCustomKV[];
  customFields?: GhlCustomKV[];
  tags?: string[];
  [k: string]: unknown;
}
interface ContactsShape {
  contacts?: GhlContact[];
  items?: GhlContact[];
  data?: GhlContact[];
  [k: string]: unknown;
}

const REQUIRED_ENV = ["GHL_API_KEY"] as const;
function reqEnv(name: string): string {
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

function normalizeToE164HK(input: string): string {
  let s = (input || "").trim();
  if (!s) return s;
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (s.startsWith("+")) return s.replace(/[^\d+]/g, "");
  const digits = s.replace(/\D/g, "");
  if (!digits) return s;
  if (/^\d{8}$/.test(digits)) return `+852${digits}`;
  if (/^852\d{8}$/.test(digits)) return `+${digits}`;
  return `+${digits}`;
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

const cfKeyToIdCache = new Map<string, string | null>();

export async function getCustomFieldIdByKey(fieldKey: string): Promise<string | null> {
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

export async function updateContactCustomField(contactId: string, fieldKey: string, value: string | number): Promise<boolean> {
  const token = reqEnv("GHL_API_KEY");
  const fieldId = await getCustomFieldIdByKey(fieldKey);
  if (!fieldId) return false;

  const body = { customField: [{ id: fieldId, value: String(value) }] };
  for (const base of DEFAULT_BASES) {
    try {
      const r = await fetch(`${base}/v1/contacts/${contactId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

export async function findContactsByCustomPhone(fieldKey: string, phoneRaw: string): Promise<GhlContact[]> {
  const target = normalizeToE164HK(phoneRaw);
  if (!target) return [];
  const fieldId = await getCustomFieldIdByKey(fieldKey);
  if (!fieldId) return [];

  const found: GhlContact[] = [];
  const queries = buildPhoneSearchVariants(phoneRaw);
  for (const q of queries) {
    const data = await ghlGet("/v1/contacts/", { query: q, limit: 50, page: 1 });
    const arr = pickContactsArray(data);
    for (const c of arr) {
      const fields = (c.customField || c.customFields || []) as GhlCustomKV[];
      const hit = fields.find(f => f.id === fieldId);
      const val = hit ? normalizeToE164HK(String(hit.value || "")) : "";
      if (val && val === target) found.push(c);
    }
  }
  const map = new Map<string, GhlContact>();
  for (const c of found) if (c.id) map.set(c.id, c);
  return [...map.values()];
}

// ============================================================
// [出席計時] 拉有指定 tag 的所有 contact
// ============================================================
export async function getContactsByTag(tag: string): Promise<GhlContact[]> {
  const all: GhlContact[] = [];
  let page = 1;
  for (let i = 0; i < 50; i++) {
    const data = await ghlGet("/v1/contacts/", { query: tag, limit: 100, page });
    const arr = pickContactsArray(data);
    const filtered = arr.filter((c: any) => {
      const tags = (c.tags || []).map((t: string) => String(t).toLowerCase());
      return tags.includes(tag.toLowerCase());
    });
    all.push(...filtered);
    if (arr.length < 100) break;
    page++;
  }
  const map = new Map<string, GhlContact>();
  for (const c of all) if (c.id) map.set(c.id, c);
  return [...map.values()];
}

// ============================================================
// [出席計時] 讀取 contact 某個自訂欄位現有值
// ============================================================
export async function getContactCustomFieldValue(contactId: string, fieldKey: string): Promise<string> {
  const token = reqEnv("GHL_API_KEY");
  const fieldId = await getCustomFieldIdByKey(fieldKey);
  if (!fieldId) return "";

  for (const base of DEFAULT_BASES) {
    try {
      const r = await fetch(`${base}/v1/contacts/${contactId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!r.ok) continue;
      const data = await r.json();
      const contact = data.contact || data;
      const fields = (contact.customField || contact.customFields || []) as Array<{ id?: string; value?: unknown }>;
      const hit = fields.find(f => f.id === fieldId);
      return String(hit?.value ?? "");
    } catch {}
  }
  return "";
}

// ============================================================
// [出席計時] 讀取 location custom values
// 需要環境變數 GHL_LOCATION_ID
// ============================================================
export async function getLocationCustomValues(): Promise<Record<string, string>> {
  const token = reqEnv("GHL_API_KEY");
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) throw new Error("Missing GHL_LOCATION_ID");

  const result: Record<string, string> = {};
  for (const base of DEFAULT_BASES) {
    try {
      const r = await fetch(`${base}/v1/locations/${locationId}/customValues`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!r.ok) continue;
      const data = await r.json();
      const arr = data.customValues || data || [];
      for (const item of arr) {
        const key = String(item.name || item.key || "").trim();
        const val = String(item.value || "").trim();
        if (key) result[key] = val;
      }
      return result;
    } catch {}
  }

  // ============================================================
// [DEBUG] 讀取 location custom values
// ============================================================
export async function getLocationCustomValues(): Promise<Record<string, string>> {
  const token = reqEnv("GHL_API_KEY");
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    console.log("DEBUG: GHL_LOCATION_ID is missing");
    return {};
  }
  console.log("DEBUG: Using locationId =", locationId);

  const result: Record<string, string> = {};
  for (const base of DEFAULT_BASES) {
    try {
      const url = `${base}/v1/locations/${locationId}/customValues`;
      console.log("DEBUG: Fetching", url);
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const text = await r.text();
      console.log("DEBUG: Status", r.status, "Body:", text.slice(0, 500));
      if (!r.ok) continue;
      const data = JSON.parse(text);
      const arr = data.customValues || data || [];
      for (const item of arr) {
        const key = String(item.name || item.key || "").trim();
        const val = String(item.value || "").trim();
        if (key) result[key] = val;
      }
      return result;
    } catch (e) {
      console.log("DEBUG: Error", String(e));
    }
  }
  return result;
}
  return result;
}
