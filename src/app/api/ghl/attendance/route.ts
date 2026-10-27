// ============================================================
// [出席計時] 課後拉 Zoom 報告 → 對電話 → 更新 GHL 停留分鐘
// 用法：GET /api/ghl/attendance?webinarId=課堂編號
// 一次處理成班人，學生唔使開呢條鏈接
// ============================================================
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWebinarParticipants } from "@/lib/zoom";
import { findContactByPhone, updateContactCustomField } from "@/lib/ghl";

const MIN_SECONDS = 60 * 60;
const FIELD_MINUTES = "contact.attendance_minutes";
const FIELD_CHARGEABLE = "contact.chargeable";

function extractPhoneFromAlias(email: string): string | null {
  const m = String(email || "").match(/noemail\+(\d+)/i);
  if (!m) return null;
  const digits = m[1];
  if (digits.startsWith("852") && digits.length >= 11) return `+${digits}`;
  if (digits.length === 8) return `+852${digits}`;
  return `+${digits}`;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const webinarId = (searchParams.get("webinarId") || "").trim();
  if (!webinarId) {
    return NextResponse.json({ ok: false, error: "Missing webinarId" }, { status: 400 });
  }

  try {
    const participants = await getWebinarParticipants(webinarId);
    const groups = new Map<string, { name: string; email: string; seconds: number }>();

    for (const p of participants) {
      const email = String(p.user_email || "").toLowerCase();
      const name = String(p.name || "").trim();
      const key = email || name || "unknown";
      const prev = groups.get(key) || { name, email, seconds: 0 };
      prev.seconds += Number(p.duration || 0);
      if (name) prev.name = name;
      groups.set(key, prev);
    }

    const results = [];
    for (const g of groups.values()) {
      const minutes = Math.round(g.seconds / 60);
      const chargeable = g.seconds >= MIN_SECONDS;
      let contact = null;
      const phone = extractPhoneFromAlias(g.email);
      if (phone) contact = await findContactByPhone(phone);

      let updated = false;
      if (contact?.id) {
        updated = await updateContactCustomField(contact.id, FIELD_MINUTES, minutes);
        await updateContactCustomField(contact.id, FIELD_CHARGEABLE, chargeable ? "yes" : "no");
      }

      results.push({
        name: g.name,
        email: g.email,
        minutes,
        chargeable,
        ghlContactId: contact?.id || null,
        updated,
      });
    }

    return NextResponse.json({ ok: true, webinarId, count: results.length, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
