export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

import { findContactByPhone, extractZoomDisplayName } from "@/lib/ghl";

const ALWAYS_ALIAS_EMAIL = (process.env.ALWAYS_ALIAS_EMAIL || "").toLowerCase() === "true";

function tinyHash(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h >>> 0).toString(16).slice(0, 6);
}
function aliasEmailFor(phoneMaybe: string | undefined, contactId: string | undefined, nameVariant?: string): string {
  const base = (phoneMaybe ? String(phoneMaybe).replace(/\D/g, "") : "") || (contactId || "") || String(Math.floor(Math.random()*1e9));
  const suf = nameVariant && nameVariant.trim() ? `-${tinyHash(nameVariant.trim())}` : "";
  return `noemail+${base}${suf}@example.com`;
}
function sanitizeName(s: string, max = 96) {
  let x = (s || "").normalize("NFKC");
  x = x.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ");
  x = x.replace(/\+?\d[\d\s\-()]{6,}/g, " ");
  x = x.split("@")[0].split("#")[0].split("|")[0];
  try { x = x.replace(/\p{Extended_Pictographic}/gu, ""); } catch {}
  x = x.replace(/[^\p{L}\p{N}\s\-'. ,]/gu, " ").replace(/\s+/g, " ").trim();
  if (x.length > max) x = x.slice(0, max);
  return x || "Guest";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const phone = (searchParams.get("phone") || "").trim();
  const zoomNameFallback = (searchParams.get("zoomName") || "").trim() || undefined;
  if (!phone) return new Response(JSON.stringify({ ok: false, error: "Missing 'phone' in query." }), { status: 400, headers: { "content-type": "application/json" }});

  const contact = await findContactByPhone(phone);
  let display = "Guest";
  let emailPreferred = "";
  let phoneForZoom = phone;

  if (contact) {
    try { display = (await extractZoomDisplayName(contact))?.trim() || "Guest"; } catch { display = "Guest"; }
    emailPreferred = (contact.email || "").trim();
    phoneForZoom = (contact.phone || phone).trim();
  } else {
    display = zoomNameFallback?.trim() || "Guest";
  }

  const first = sanitizeName(display);
  const last = " ";
  const email = ALWAYS_ALIAS_EMAIL ? aliasEmailFor(phoneForZoom, contact?.id, first) : (emailPreferred || aliasEmailFor(phoneForZoom, contact?.id, first));

  return new Response(JSON.stringify({
    ok: true,
    mode: contact ? "contact-found" : "no-contact",
    contact: contact ? { id: contact.id, email: contact.email || null, phone: contact.phone || null } : null,
    zoomDisplayNameResolved: display,
    zoomMappingPreview: { first_name: first, last_name: last, email, phone: phoneForZoom }
  }), { headers: { "content-type": "application/json", "cache-control": "no-store" }});
}
