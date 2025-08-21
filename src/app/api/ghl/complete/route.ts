export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { findContactByPhone, extractZoomDisplayName } from "@/lib/ghl";
import { listWebinarOccurrences, registerZoomRegistrantSmart } from "@/lib/zoom";

type OccurrenceView = { webinarId: string; occurrenceId: string; startsAtIso: string };

// ---------- config ----------
const ALWAYS_ALIAS_EMAIL =
  (process.env.ALWAYS_ALIAS_EMAIL || "").toLowerCase() === "true";

// ---------- helpers ----------
function parseSessionValue(s: string): { webinarId: string; occurrenceId: string | null } {
  const [w, occ] = (s || "").split("|");
  const webinarId = (w || "").trim();
  const occurrenceId = ((occ || "").trim() || null);
  if (!webinarId) throw new Error("Invalid 'session'. Use 'WEBINAR_ID|auto' or 'WEBINAR_ID|<occurrenceId>'.");
  return { webinarId, occurrenceId };
}
async function pickNearestOccurrence(webinarId: string): Promise<string | null> {
  const occs: OccurrenceView[] = await listWebinarOccurrences(webinarId);
  const now = Date.now();
  const future = occs
    .map(o => ({ id: o.occurrenceId, t: Date.parse(o.startsAtIso) }))
    .filter(o => o.t > now)
    .sort((a, b) => a.t - b.t);
  return future[0]?.id ?? null;
}

// tiny hash so alias email changes when display name changes
function tinyHash(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).slice(0, 6);
}

// Build alias email. If nameVariant set, append a small hash.
function aliasEmailFor(phoneMaybe: string | undefined, contactId: string | undefined, nameVariant?: string): string {
  const baseDigits =
    (phoneMaybe ? String(phoneMaybe).replace(/\D/g, "") : "") ||
    (contactId ? String(contactId) : "") ||
    String(Math.floor(Math.random() * 1_000_000_000));
  const suffix = nameVariant && nameVariant.trim() ? `-${tinyHash(nameVariant.trim())}` : "";
  return `noemail+${baseDigits}${suffix}@example.com`;
}

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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const session = (searchParams.get("session") || "").trim();
  const phoneRaw = (searchParams.get("phone") || "").trim();
  const zoomNameFallback = (searchParams.get("zoomName") || "").trim() || undefined;

  if (!session || !phoneRaw) {
    return NextResponse.json({ ok: false, error: "Missing 'session' or 'phone' in query." }, { status: 400 });
  }

  try {
    const { webinarId, occurrenceId } = parseSessionValue(session);
    const occ =
      !occurrenceId || occurrenceId === "auto"
        ? await pickNearestOccurrence(webinarId)
        : occurrenceId;

    if (!occ) return NextResponse.json({ ok: false, error: "No future occurrence found for this webinar" }, { status: 404 });

    const contact = await findContactByPhone(phoneRaw);

    // Resolve display name (only from zoom_display_name or fallback)
    let displayNameRaw = "Guest";
    let phoneForZoom = phoneRaw;
    let emailPreferred = "";  // real email if we intend to use it

    if (contact) {
      try {
        const z = await extractZoomDisplayName(contact);
        displayNameRaw = (z && z.trim()) || "Guest";
      } catch { displayNameRaw = "Guest"; }
      phoneForZoom = (contact.phone || phoneRaw).trim();
      emailPreferred = (contact.email || "").trim();
    } else {
      displayNameRaw = zoomNameFallback?.trim() || "Guest";
    }

    const firstNameForZoom = sanitizeZoomName(displayNameRaw, 96) || "Guest";
    const lastNameForZoom  = " ";

    // Email selection:
    // - If ALWAYS_ALIAS_EMAIL=true → always alias by name (so name changes create new registrants)
    // - Else → use real email when present, otherwise alias
    const email = ALWAYS_ALIAS_EMAIL
      ? aliasEmailFor(phoneForZoom, contact?.id, firstNameForZoom)
      : (emailPreferred || aliasEmailFor(phoneForZoom, contact?.id, firstNameForZoom));

    const reg = await registerZoomRegistrantSmart({
      webinarId,
      occurrenceId: occ,
      firstName: firstNameForZoom,
      lastName: lastNameForZoom,
      email,
      phone: phoneForZoom
    });

    const joinUrl = (reg as { join_url?: string }).join_url;
    if (!joinUrl) return NextResponse.json({ ok: false, error: "Zoom did not return join_url" }, { status: 502 });

    return NextResponse.redirect(joinUrl, { status: 302 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Registration failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
