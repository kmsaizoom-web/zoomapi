export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { findContactByPhone, extractZoomDisplayName } from "@/lib/ghl";
import { listWebinarOccurrences, registerZoomRegistrantSmart } from "@/lib/zoom";

type OccurrenceView = { webinarId: string; occurrenceId: string; startsAtIso: string };
const ALWAYS_ALIAS_EMAIL = (process.env.ALWAYS_ALIAS_EMAIL || "").toLowerCase() === "true";

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

function sanitizeName(s: string, max = 96) {
  let x = (s || "").normalize("NFKC");
  // strip emails / long numbers / separators
  x = x.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ");
  x = x.replace(/\+?\d[\d\s\-()]{6,}/g, " ");
  x = x.split("@")[0].split("#")[0].split("|")[0];
  // strip emojis & odd punct
  try { x = x.replace(/\p{Extended_Pictographic}/gu, ""); } catch {}
  x = x.replace(/[^\p{L}\p{N}\s\-'. ,]/gu, " ").replace(/\s+/g, " ").trim();
  if (x.length > max) x = x.slice(0, max);
  return x;
}

function looksLikePlaceholder(v: string) {
  const s = (v ?? "").trim();
  if (!s) return true;
  if (/^\{\{.*\}\}$/.test(s)) return true;               // e.g., {{contact.zoom_name}}
  if (/^(null|undefined|na|n\/a)$/i.test(s)) return true; // common “empty” strings
  return false;
}

/**
 * Decide display name with robust fallback:
 *   1) Use GHL zoom_display_name if present (after sanitize)
 *   2) Else use the form-provided zoomName if present & not placeholder (after sanitize)
 *   3) Else "Guest"
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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const session = (searchParams.get("session") || "").trim();
  const phoneRaw = (searchParams.get("phone") || "").trim();
  // IMPORTANT: the key must match your form: &zoomName={{contact.zoom_name}}
  const zoomNameFromForm = (searchParams.get("zoomName") || "").trim();

  if (!session || !phoneRaw) {
    return NextResponse.json(
      { ok: false, error: "Missing 'session' or 'phone' in query." },
      { status: 400 }
    );
  }

  const { webinarId, occurrenceId } = parseSession(session);
  if (!webinarId) {
    return NextResponse.json({ ok: false, error: "Invalid 'session' format." }, { status: 400 });
  }

  const occ = (!occurrenceId || occurrenceId === "auto") ? await pickNearest(webinarId) : occurrenceId;
  if (!occ) {
    return NextResponse.json(
      { ok: false, error: "No future occurrence found for this webinar" },
      { status: 404 }
    );
  }

  // Try to locate contact in GHL by phone
  const contact = await findContactByPhone(phoneRaw);

  // Extract candidate pieces
  let ghlDisplayName = "";
  let phoneForZoom = phoneRaw;
  let realEmail = "";

  if (contact) {
    try {
      ghlDisplayName = (await extractZoomDisplayName(contact))?.trim() || "";
    } catch {
      ghlDisplayName = "";
    }
    phoneForZoom = (contact.phone || phoneRaw).trim();
    realEmail = (contact.email || "").trim();
  }

  // PICK FINAL DISPLAY NAME (core fix)
  const display = pickDisplayName(ghlDisplayName, zoomNameFromForm);

  // Zoom likes first/last split; provide minimal last if missing
  const [firstNameForZoom, ...restParts] = display.split(/\s+/);
  const lastNameForZoom = restParts.join(" ") || "-";

  // Email (respect ALWAYS_ALIAS_EMAIL)
  const email = ALWAYS_ALIAS_EMAIL
    ? aliasEmailFor(phoneForZoom, contact?.id, display)
    : (realEmail || aliasEmailFor(phoneForZoom, contact?.id, display));

  // Register (with reuse/lookup handled inside your zoom helper)
  const reg = await registerZoomRegistrantSmart({
    webinarId,
    occurrenceId: occ,
    firstName: sanitizeName(firstNameForZoom) || "Guest",
    lastName: sanitizeName(lastNameForZoom) || "-",
    email,
    phone: phoneForZoom
  });

  const joinUrl = (reg as any)?.join_url;
  if (!joinUrl) {
    return NextResponse.json({ ok: false, error: "Zoom did not return join_url" }, { status: 502 });
  }

  return NextResponse.redirect(joinUrl, { status: 302 });
}
