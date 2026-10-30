// ============================================================
// [出席計時]
// 1. 入課電話對 contact.Phone
// 2. 用 field id 讀該 contact 的 Student Phone / Parent Phone
// 3. 再用該號碼對 Phone，以及 Student Phone / Parent Phone 欄
// 4. 全部寫入同一套出席分鐘同 Chargeable
// ============================================================
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWebinarParticipants } from "@/lib/zoom";
import {
  findContactByPhone,
  findContactsByCustomPhone,
  updateContactCustomField,
  getCustomFieldIdByKey,
} from "@/lib/ghl";

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

function readById(contact: any, fieldId: string | null): string {
  if (!fieldId || !contact) return "";
  const fields = (contact.customField || contact.customFields || []) as Array<{ id?: string; value?: unknown }>;
  const hit = fields.find((f) => f.id === fieldId);
  return String(hit?.value || "").trim();
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

    const studentFieldId = await getCustomFieldIdByKey(FIELD_STUDENT_PHONE);
    const parentFieldId = await getCustomFieldIdByKey(FIELD_PARENT_PHONE);

    const results = [];
    for (const g of groups.values()) {
      const minutes = Math.round(g.seconds / 60);
      const chargeable = g.seconds >= MIN_SECONDS;
      const loginPhone = extractPhoneFromAlias(g.email);
      const contacts = new Map<string, any>();
      const relatedPhones: string[] = [];

      if (loginPhone) {
        // 1) 入課電話對主電話 Phone
        const primary = await findContactByPhone(loginPhone);
        if (primary?.id) contacts.set(primary.id, primary);

        // 2) 讀對到的 contact 的 Student Phone / Parent Phone
        const related = new Set<string>();
        for (const c of contacts.values()) {
          const sp = readById(c, studentFieldId);
          const pp = readById(c, parentFieldId);
          if (sp) related.add(sp);
          if (pp) related.add(pp);
        }
        relatedPhones.push(...related);

        // 3) 再用該號碼對 Phone，以及兩個自訂電話欄
        for (const phone of related) {
          const byPhone = await findContactByPhone(phone);
          if (byPhone?.id) contacts.set(byPhone.id, byPhone);

          for (const c of await findContactsByCustomPhone(FIELD_STUDENT_PHONE, phone)) {
            if (c.id) contacts.set(c.id, c);
          }
          for (const c of await findContactsByCustomPhone(FIELD_PARENT_PHONE, phone)) {
            if (c.id) contacts.set(c.id, c);
          }
        }
      }

      const updatedIds: string[] = [];
      for (const c of contacts.values()) {
        const ok = await updateContactCustomField(c.id, FIELD_MINUTES, minutes);
        await updateContactCustomField(c.id, FIELD_CHARGEABLE, chargeable ? "yes" : "no");
        if (ok) updatedIds.push(c.id);
      }

      results.push({
        name: g.name,
        loginPhone,
        relatedPhones,
        studentFieldId,
        parentFieldId,
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
