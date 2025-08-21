export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { findContactByPhone, extractZoomDisplayName } from "@/lib/ghl";
import { listWebinarOccurrences, registerZoomRegistrantSmart } from "@/lib/zoom";

type OccurrenceView = { webinarId: string; occurrenceId: string; startsAtIso: string };
type Body = Partial<{ session: string; webinarId: string; occurrenceId: string | null; phone: string; zoomName: string }>;

const ALWAYS_ALIAS_EMAIL = (process.env.ALWAYS_ALIAS_EMAIL || "").toLowerCase() === "true";

function json<T extends object>(data: T, status = 200) {
  const res = NextResponse.json(data, { status });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}
export async function OPTIONS() { return json({}, 204); }

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

export async function POST(req: Request) {
  let body: Body; try { body = await req.json() as Body; } catch { return json({ ok:false, error:"Invalid JSON body" }, 400); }
  const phoneRaw = (body.phone || "").toString().trim();
  if (!phoneRaw) return json({ ok:false, error:"Missing 'phone' in body" }, 400);

  let webinarId = ""; let occurrenceId: string | null = null;
  try {
    if (body.session) { const p = parseSession(String(body.session)); webinarId = p.webinarId; occurrenceId = p.occurrenceId; }
    else if (body.webinarId) { webinarId = String(body.webinarId).trim(); occurrenceId = (body.occurrenceId || "").toString().trim() || null; }
  } catch (e: any) { return json({ ok:false, error: e?.message || "Invalid session" }, 400); }
  if (!webinarId) return json({ ok:false, error:"Missing 'session' or 'webinarId' in body" }, 400);

  const occ = (!occurrenceId || occurrenceId === "auto") ? await pickNearest(webinarId) : occurrenceId;
  if (!occ) return json({ ok:false, error:"No future occurrence found for this webinar" }, 404);

  const contact = await findContactByPhone(phoneRaw);

  let display = "Guest";
  let phoneForZoom = phoneRaw;
  let realEmail = "";

  if (contact) {
    try { display = (await extractZoomDisplayName(contact))?.trim() || "Guest"; } catch { display = "Guest"; }
    phoneForZoom = (contact.phone || phoneRaw).trim();
    realEmail = (contact.email || "").trim();
  } else {
    display = (body.zoomName || "").toString().trim() || "Guest";
  }

  const first = sanitizeName(display);
  const last  = " ";
  const email = ALWAYS_ALIAS_EMAIL ? aliasEmailFor(phoneForZoom, contact?.id, first)
                                   : (realEmail || aliasEmailFor(phoneForZoom, contact?.id, first));

  const reg = await registerZoomRegistrantSmart({
    webinarId, occurrenceId: occ, firstName: first, lastName: last, email, phone: phoneForZoom
  });
  const joinUrl = (reg as any)?.join_url;
  if (!joinUrl) return json({ ok:false, error:"Zoom did not return join_url" }, 502);

  return json({ ok:true, webinarId, occurrenceId: occ, join_url: joinUrl, email_mode: ALWAYS_ALIAS_EMAIL ? "alias" : (realEmail ? "real" : "alias") });
}
