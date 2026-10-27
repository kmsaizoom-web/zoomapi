// ============================================================
// [出席計時] Zoom 課堂完結 webhook
// 收到 webinar.ended / meeting.ended 後等 90 秒，再打 attendance API
// Endpoint：https://zoom.hkwisekids.com/api/zoom/webhook
// ============================================================
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import crypto from "crypto";

const SECRET = process.env.ZOOM_WEBHOOK_SECRET || "";

function verify(req: Request, body: string) {
  const sig = req.headers.get("x-zm-signature") || "";
  const ts = req.headers.get("x-zm-request-timestamp") || "";
  const msg = `v0:${ts}:${body}`;
  const hash = crypto.createHmac("sha256", SECRET).update(msg).digest("hex");
  return sig === `v0=${hash}`;
}

export async function POST(req: Request) {
  const raw = await req.text();
  let json: any = {};
  try { json = JSON.parse(raw); } catch {}

  if (json.event === "endpoint.url_validation") {
    const plain = json.payload?.plainToken || "";
    const encrypted = crypto.createHmac("sha256", SECRET).update(plain).digest("hex");
    return NextResponse.json({ plainToken: plain, encryptedToken: encrypted });
  }

  if (SECRET && !verify(req, raw)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  if (json.event === "webinar.ended" || json.event === "meeting.ended") {
    const webinarId = String(json.payload?.object?.id || "");
    if (webinarId) {
      await new Promise(r => setTimeout(r, 90_000));
      const url = `https://zoom.hkwisekids.com/api/ghl/attendance?webinarId=${encodeURIComponent(webinarId)}`;
      await fetch(url).catch(() => {});
    }
  }

  return NextResponse.json({ ok: true });
}
