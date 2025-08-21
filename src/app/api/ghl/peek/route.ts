export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { findContactByPhone, extractZoomDisplayName } from "@/lib/ghl";

function sanitizeZoomName(input: string, maxLen = 96): string {
  if (!input) return "";
  let s = input.normalize("NFKC");
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ");
  s = s.replace(/\+?\d[\d\s\-()]{6,}/g, " ");
  s = s.split("@")[0].split("#")[0].split("|")[0];
  try { s = s.replace(/\p{Extended_Pictographic}/gu, ""); } catch {}
  s = s.replace(/[^\p{L}\p{N}\s\-'. ,]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}
function tinyHash(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h >>> 0).toString(16).slice(0, 6);
}
function fallbackEmailFor(phoneMaybe: string | undefined, contactId: string | undefined, nameVariant?: string): string {
  const base =
    (phoneMaybe ? String(phoneMaybe).replace(/\D/g, "") : "") ||
    (contactId ? String(contactId) : "") ||
    String(Math.floor(Math.random() * 1_000_000_000));
  const suffix = nameVariant && nameVariant.trim() ? `-${tinyHash(nameVariant.trim())}` : "";
  return `noemail+${base}${suffix}@example.com`;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const phoneRaw = (searchParams.get("phone") || "").trim();
  const zoomName = (searchParams.get("zoomName") || "").trim() || undefined;

  if (!phoneRaw) {
    return new Response(JSON.stringify({ ok: false, error: "Missing 'phone' in query." }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  try {
    const contact = await findContactByPhone(phoneRaw);

    let displayName = "Guest";
    let email: string;
    let phone = phoneRaw;

    if (contact) {
      const z = (await extractZoomDisplayName(contact)) || "Guest";
      displayName = z.trim() || "Guest";
      email = (contact.email || "").trim()
        || fallbackEmailFor(contact.phone || phoneRaw, contact.id, displayName);
      phone = (contact.phone || phoneRaw).trim();
    } else {
      displayName = zoomName?.trim() || "Guest";
      email = fallbackEmailFor(phoneRaw, undefined, displayName);
    }

    const first = sanitizeZoomName(displayName, 96) || "Guest";
    const last = " ";

    return new Response(JSON.stringify({
      ok: true,
      mode: contact ? "contact-found" : "no-contact",
      inputPhone: phoneRaw,
      contact: contact ? {
        id: contact.id,
        firstName: contact.firstName ?? null,
        lastName: contact.lastName ?? null,
        email: contact.email ?? null,
        phone: contact.phone ?? null
      } : null,
      zoomDisplayNameResolved: displayName,
      zoomMappingPreview: { first_name: first, last_name: last, email, phone }
    }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }});
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Lookup failed";
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
}
