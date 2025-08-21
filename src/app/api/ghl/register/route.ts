export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { findContactByPhone, extractZoomDisplayName } from "@/lib/ghl";
import { listWebinarOccurrences, registerZoomRegistrantSmart } from "@/lib/zoom";

type OccurrenceView = { webinarId: string; occurrenceId: string; startsAtIso: string };
type BodySession = { session: string; phone: string; zoomName?: string };
type BodyIds = { webinarId: string; occurrenceId?: string | null; phone: string; zoomName?: string };
type Body = Partial<BodySession & BodyIds>;

// ---------- config ----------
const ALWAYS_ALIAS_EMAIL =
  (process.env.ALWAYS_ALIAS_EMAIL || "").toLowerCase() === "true";

// ---------- helpers ----------
function jsonCORS<T extends object>(data: T, status = 200): NextResponse<T> {
  const res = NextResponse.json(data, { status });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}
export async function OPTIONS() { return jsonCORS({}, 204); }

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

export async function POST(req: Request) {
  let body: Body;
  try { body = (await req.json()) as Body; }
  catch { return jsonCORS({ ok: false, error: "Invalid JSON body" }, 400); }

  const phoneRaw = (body.phone ?? "").toString().trim();
  const zoomNameFromBody = (body.zoomName ?? "").toString().trim() || undefined;
  if (!phoneRaw) return jsonCORS({ ok: false, error: "Missing 'phone' in body" }, 400);

  // session parsing
  let webinarId = "";
  let occurrenceId: string | null = null;
  try {
    if (body.session) {
      const parsed = parseSessionValue(String(body.session));
      webinarId = parsed.webinarId;
      occurrenceId = parsed.occurrenceId;
    } else if (body.webinarId) {
      webinarId = String(body.webinarId).trim();
      occurrenceId = (body.occurrenceId ?? "").toString().trim() || null;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid session";
    return jsonCORS({ ok: false, error: msg }, 400);
  }
  if (!webinarId) return jsonCORS({ ok: false, error: "Missing 'session' or 'webinarId' in body" }, 400);

  try {
    const occ =
      !occurrenceId || occurrenceId === "auto"
        ? await pickNearestOccurrence(webinarId)
        : occurrenceId;
    if (!occ) return jsonCORS({ ok: false, error: "No future occurrence found for this webinar" }, 404);

    const contact = await findContactByPhone(phoneRaw);

    let displayNameRaw = "Guest";
    let phoneForZoom = phoneRaw;
    let emailPreferred = "";

    if (contact) {
      try {
        const z = await extractZoomDisplayName(contact);
        displayNameRaw = (z && z.trim()) || "Guest";
      } catch { displayNameRaw = "Guest"; }
      phoneForZoom = (contact.phone || phoneRaw).trim();
      emailPreferred = (contact.email || "").trim();
    } else {
      displayNameRaw = zoomNameFromBody?.trim() || "Guest";
    }

    const firstNameForZoom = sanitizeZoomName(displayNameRaw, 96) || "Guest";
    const lastNameForZoom  = " ";

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
    if (!joinUrl) return jsonCORS({ ok: false, error: "Zoom did not return join_url" }, 502);

    return jsonCORS({
      ok: true,
      webinarId,
      occurrenceId: occ,
      used_contact: Boolean(contact),
      email_mode: ALWAYS_ALIAS_EMAIL ? "alias" : (emailPreferred ? "real" : "alias"),
      join_url: joinUrl
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Registration failed";
    return jsonCORS({ ok: false, error: msg }, 500);
  }
}
