export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { findContactByPhone, extractZoomDisplayName } from "@/lib/ghl";
import { listWebinarOccurrences, registerZoomRegistrantSmart } from "@/lib/zoom";

type OccurrenceView = { webinarId: string; occurrenceId: string; startsAtIso: string };
const ALWAYS_ALIAS_EMAIL = (process.env.ALWAYS_ALIAS_EMAIL || "").toLowerCase() === "true";

function parseSession(s: string) { const [w, occ] = (s || "").split("|"); return { webinarId: (w||"").trim(), occurrenceId: ((occ||"").trim() || null) }; }
async function pickNearest(webinarId: string): Promise<string | null> {
  const occs: OccurrenceView[] = await listWebinarOccurrences(webinarId);
  const now = Date.now();
  const f = occs.map(o => ({ id: o.occurrenceId, t: Date.parse(o.startsAtIso) })).filter(o => o.t > now).sort((a,b)=>a.t-b.t);
  return f[0]?.id ?? null;
}
function tinyHash(input: string): string { let h=2166136261>>>0; for (let i=0;i<input.length;i++){h^=input.charCodeAt(i); h=Math.imul(h,16777619)>>>0;} return (h>>>0).toString(16).slice(0,6); }
function aliasEmailFor(phoneMaybe?: string, contactId?: string, nameVariant?: string) {
  const base = (phoneMaybe ? String(phoneMaybe).replace(/\D/g,"") : "") || (contactId || "") || String(Math.floor(Math.random()*1e9));
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
  const session = (searchParams.get("session") || "").trim();
  const phoneRaw = (searchParams.get("phone") || "").trim();
  const zoomNameFallback = (searchParams.get("zoomName") || "").trim() || undefined;

  if (!session || !phoneRaw) return NextResponse.json({ ok: false, error: "Missing 'session' or 'phone' in query." }, { status: 400 });

  const { webinarId, occurrenceId } = parseSession(session);
  if (!webinarId) return NextResponse.json({ ok: false, error: "Invalid 'session' format." }, { status: 400 });

  const occ = (!occurrenceId || occurrenceId === "auto") ? await pickNearest(webinarId) : occurrenceId;
  if (!occ) return NextResponse.json({ ok: false, error: "No future occurrence found for this webinar" }, { status: 404 });

  const contact = await findContactByPhone(phoneRaw);

  // Display name solely from zoom_display_name or provided fallback
  let display = "Guest";
  let phoneForZoom = phoneRaw;
  let realEmail = "";

  if (contact) {
    try { display = (await extractZoomDisplayName(contact))?.trim() || "Guest"; } catch { display = "Guest"; }
    phoneForZoom = (contact.phone || phoneRaw).trim();
    realEmail = (contact.email || "").trim();
  } else {
    display = zoomNameFallback?.trim() || "Guest";
  }

  const firstNameForZoom = sanitizeName(display);
  const lastNameForZoom  = " ";
  const email = ALWAYS_ALIAS_EMAIL ? aliasEmailFor(phoneForZoom, contact?.id, firstNameForZoom)
                                   : (realEmail || aliasEmailFor(phoneForZoom, contact?.id, firstNameForZoom));

  const reg = await registerZoomRegistrantSmart({
    webinarId, occurrenceId: occ,
    firstName: firstNameForZoom, lastName: lastNameForZoom,
    email, phone: phoneForZoom
  });

  const joinUrl = (reg as any)?.join_url;
  if (!joinUrl) return NextResponse.json({ ok: false, error: "Zoom did not return join_url" }, { status: 502 });

  return NextResponse.redirect(joinUrl, { status: 302 });
}
