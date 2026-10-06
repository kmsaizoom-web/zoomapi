export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;
import { NextResponse } from "next/server";
import { findContactByPhone, extractZoomDisplayName } from "@/lib/ghl";
import { listWebinarOccurrences, registerZoomRegistrantSmart } from "@/lib/zoom";
type OccurrenceView = { webinarId: string; occurrenceId: string; startsAtIso: string };
const ALWAYS_ALIAS_EMAIL = (process.env.ALWAYS_ALIAS_EMAIL || "").toLowerCase() === "true";
// Use a zero-width space for empty last names so Zoom doesn't show a dash.
const EMPTY_LAST_NAME = "\u200B"; // U+200B
function parseSession(s: string) {
  const [w, occ] = (s || "").split("|");
  return { webinarId: (w || "").trim(), occurrenceId: ((occ || "").trim() || null) };
}
async function pickNearest(webinarId: string): Promise<string | null> {
  const occs: OccurrenceView[] = await listWebinarOccurrences(webinarId);
  const now = Date.now();
  const f = occs
    .map(o => ({ id: o.occurrenceId, t: Date.parse(o.startsAtIso) }))
    .filter(o => o.t > now)
    .sort((a, b) => a.t - b.t);
  return f[0]?.id ?? null;
}
function tinyHash(input: string): string {
  let h = (2166136261 >>> 0);
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).slice(0, 6);
}
function aliasEmailFor(phoneMaybe?: string, contactId?: string, nameVariant?: string) {
  const base =
    (phoneMaybe ? String(phoneMaybe).replace(/\D/g, "") : "") ||
    (contactId || "") ||
    String(Math.floor(Math.random() * 1e9));
  const suf = nameVariant && nameVariant.trim() ? `-${tinyHash(nameVariant.trim())}` : "";
  return `noemail+${base}${suf}@example.com`;
}
/**
 * Improved sanitizer to remove quotes, dashes, and odd trailing punctuation
 */
function sanitizeName(s: string, max = 96) {
  let x = (s || "").normalize("NFKC");
  // Remove any wrapping quotes or dashes
  x = x.replace(/^["'“”‘’\-–—\s]+|["'“”‘’\-–—\s]+$/g, "");
  // strip emails, long numbers, separators
  x = x.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ");
  x = x.replace(/\+?\d[\d\s\-()]{6,}/g, " ");
  x = x.split("@")[0].split("#")[0].split("|")[0];
  // strip emojis & odd punct
  try { x = x.replace(/\p{Extended_Pictographic}/gu, ""); } catch {}
  x = x.replace(/[^\p{L}\p{N}\s\-'.]/gu, " ").replace(/\s+/g, " ").trim();
  if (x.length > max) x = x.slice(0, max);
  return x;
}
function looksLikePlaceholder(v: string) {
  const s = (v ?? "").trim();
  if (!s) return true;
  if (/^\{\{.*\}\}$/.test(s)) return true;
  if (/^(null|undefined|na|n\/a)$/i.test(s)) return true;
  return false;
}
/**
 * Decide display name with robust fallback:
 *   1) GHL zoom_display_name
 *   2) form zoomName
 *   3) "Guest"
 */
function pickDisplayName(ghlName?: string | null, formName?: string | null) {
  const c1 = sanitizeName((ghlName ?? "").trim());
  if (c1) return c1;
  const rawForm = (formName ?? "").trim();
  if (!looksLikePlaceholder(rawForm)) {
    const c2 = sanitizeName(rawForm);
    if (c2) return c2;
  }
  return "Guest";
}
function fallbackJoinUrl(webinarId: string) {
  return `https://zoom.us/w/${encodeURIComponent(webinarId)}`;
}
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const session = (searchParams.get("session") || "").trim();
  const phoneRaw = (searchParams.get("phone") || "").trim();
  const zoomNameFromForm = (searchParams.get("zoomName") || "").trim();
  const { webinarId, occurrenceId } = parseSession(session);
  if (!webinarId) {
    return NextResponse.json({ ok: false, error: "Invalid 'session' format." }, { status: 400 });
  }
  const goFallback = () => NextResponse.redirect(fallbackJoinUrl(webinarId), { status: 302 });
  try {
    const occ = (!occurrenceId || occurrenceId === "auto")
      ? await withTimeout(pickNearest(webinarId), 4000)
      : occurrenceId;
    if (!occ) return goFallback();
    let ghlDisplayName = "";
    let phoneForZoom = phoneRaw || "unknown";
    let realEmail = "";
    let contactId: string | undefined;
    if (phoneRaw) {
      try {
        const contact = await withTimeout(findContactByPhone(phoneRaw), 3000);
        if (contact) {
          contactId = contact.id;
          try {
            ghlDisplayName = (await extractZoomDisplayName(contact))?.trim() || "";
          } catch {
            ghlDisplayName = "";
          }
          phoneForZoom = (contact.phone || phoneRaw).trim();
          realEmail = (contact.email || "").trim();
        }
      } catch {
        // GHL slow or failed: continue with the form name
      }
    }
    const display = pickDisplayName(ghlDisplayName, zoomNameFromForm);
    const [firstRaw, ...restParts] = display.split(/\s+/);
    const firstNameForZoom = sanitizeName(firstRaw) || "Guest";
    let lastNameForZoom = sanitizeName(restParts.join(" "));
    if (!lastNameForZoom) {
      lastNameForZoom = EMPTY_LAST_NAME;
    }
    const email = ALWAYS_ALIAS_EMAIL
      ? aliasEmailFor(phoneForZoom, contactId, display)
      : (realEmail || aliasEmailFor(phoneForZoom, contactId, display));
    const reg = await withTimeout(registerZoomRegistrantSmart({
      webinarId,
      occurrenceId: occ,
      firstName: firstNameForZoom,
      lastName: lastNameForZoom,
      email,
      phone: phoneForZoom
    }), 5000);
    const joinUrl = (reg as any)?.join_url;
    if (!joinUrl) return goFallback();
    return NextResponse.redirect(joinUrl, { status: 302 });
  } catch {
    return goFallback();
  }
}
