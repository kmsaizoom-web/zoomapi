// ============================================================
// [出席計時] 課後拉 Zoom 報告 → 對電話（主電話 / 學生電話 / 家長電話）→ 更新 GHL
// 用法：GET /api/ghl/attendance?webinarId=課堂編號
// ============================================================
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWebinarParticipants } from "@/lib/zoom";
import { findContactByPhone, findContactsByCustomPhone, updateContactCustomField } from "@/lib/ghl";

const MIN_SECONDS = 60 * 60;
const FIELD_MINUTES = "contact.attendance_minutes";
const FIELD_CHARGEABLE = "contact.chargeable";
const FIELD_STUDENT_PHONE = "contact.students_your_child_phone_number";
const FIELD_PARENT_PHONE = "contact.parents_phone_number";

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
      const phone = extractPhoneFromAlias(g.email);

      const contacts = new Map<string, any>();
      if (phone) {
        const main = await findContactByPhone(phone);
        if (main?.id) contacts.set(main.id, main);

        const byStudent = await findContactsByCustomPhone(FIELD_STUDENT_PHONE, phone);
        for (const c of byStudent) if (c.id) contacts.set(c.id, c);

        const byParent = await findContactsByCustomPhone(FIELD_PARENT_PHONE, phone);
        for (const c of byParent) if (c.id) contacts.set(c.id, c);
      }

      const updatedIds: string[] = [];
      for (const c of contacts.values()) {
        const ok = await updateContactCustomField(c.id, FIELD_MINUTES, minutes);
        await updateContactCustomField(c.id, FIELD_CHARGEABLE, chargeable ? "yes" : "no");
        if (ok) updatedIds.push(c.id);
      }

      results.push({
        name: g.name,
        email: g.email,
        minutes,
        chargeable,
        matchedContacts: [...contacts.keys()],
        updatedIds,
      });
    }

    return NextResponse.json({ ok: true, webinarId, count: results.length, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
