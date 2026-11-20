// ============================================================
// [出席計時]
// 原有功能保留：
//   - 用入課電話對 contact，更新 attendance_minutes + chargeable
// 新增功能：
//   - 用 GHL custom value 對應年級
//   - 只對該年級 + paid student 累計 total_class_ticket / absent_class_times
//   - 今堂沒達標（包括完全沒入）→ chargeable 設為 no
//   - 同時更新學生同相關家長
//   - attendance_minutes 只在有入 Zoom 時更新
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
  getContactsByTag,
  getContactCustomFieldValue,
  getLocationCustomValues,
} from "@/lib/ghl";

const MIN_SECONDS = 30 * 60;
const MIN_MINUTES = 30;
const FIELD_MINUTES = "contact.attendance_minutes";
const FIELD_CHARGEABLE = "contact.chargeable";
const FIELD_STUDENT_PHONE = "contact.students_your_child_phone_number";
const FIELD_PARENT_PHONE = "contact.parents_phone_number";
const FIELD_TOTAL = "contact.total_class_ticket";
const FIELD_ABSENT = "contact.absent_class_times";
const FIELD_GRADE = "contact.current_grade";
const TAG_PAID = "paid student";

const GRADE_MAP: Record<string, string> = {
  s1_zoom_meeting_id: "中一",
  s2_zoom_meeting_id: "中二",
  s3_zoom_meeting_id: "中三",
  s4_zoom_meeting_id: "中四",
  s5_zoom_meeting_id: "中五",
  s6_zoom_meeting_id: "中六",
};

function extractPhoneFromAlias(email: string): string | null {
  const m = String(email || "").match(/noemail\+(\d+)/i);
  if (!m) return null;
  const digits = m[1];
  if (digits.startsWith("852") && digits.length >= 11) return `+${digits}`;
  if (digits.length === 8) return `+852${digits}`;
  return `+${digits}`;
}

function normalizePhone(p: string): string {
  const digits = String(p || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("852") && digits.length >= 11) return `+${digits}`;
  if (digits.length === 8) return `+852${digits}`;
  return `+${digits}`;
}

function cleanId(raw: string): string {
  return String(raw || "").replace(/\s+/g, "");
}

function readById(contact: any, fieldId: string | null): string {
  if (!fieldId || !contact) return "";
  const fields = (contact.customField || contact.customFields || []) as Array<{ id?: string; value?: unknown }>;
  const hit = fields.find((f) => f.id === fieldId);
  return String(hit?.value || "").trim();
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const webinarIdRaw = (searchParams.get("webinarId") || "").trim();
  const webinarId = cleanId(webinarIdRaw);
  if (!webinarId) {
    return NextResponse.json({ ok: false, error: "Missing webinarId" }, { status: 400 });
  }

  try {
    // ========== 原有功能：更新有入 Zoom 的人 ==========
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

    const originalResults = [];
    for (const g of groups.values()) {
      const minutes = Math.round(g.seconds / 60);
      const chargeable = g.seconds >= MIN_SECONDS;
      const loginPhone = extractPhoneFromAlias(g.email);
      const contacts = new Map<string, any>();
      const relatedPhones: string[] = [];

      if (loginPhone) {
        const primary = await findContactByPhone(loginPhone);
        if (primary?.id) contacts.set(primary.id, primary);

        const related = new Set<string>();
        for (const c of contacts.values()) {
          const sp = readById(c, studentFieldId);
          const pp = readById(c, parentFieldId);
          if (sp) related.add(sp);
          if (pp) related.add(pp);
        }
        relatedPhones.push(...related);

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

      originalResults.push({
        name: g.name,
        loginPhone,
        relatedPhones,
        minutes,
        chargeable,
        matchedContacts: [...contacts.keys()],
        updatedIds,
      });
    }

    // ========== 新增功能：按年級累計 + 沒達標設 chargeable = no ==========
    const customValues = await getLocationCustomValues();
    let targetGrade = "";
    for (const [key, grade] of Object.entries(GRADE_MAP)) {
      const val = cleanId(customValues[key] || "");
      if (val && val === webinarId) {
        targetGrade = grade;
        break;
      }
    }

    const countResults = [];
    if (targetGrade) {
      const attendedByPhone = new Map<string, number>();
      for (const p of participants) {
        const email = String(p.user_email || "").toLowerCase();
        const phone = extractPhoneFromAlias(email);
        if (!phone) continue;
        const mins = Math.round(Number(p.duration || 0) / 60);
        attendedByPhone.set(phone, (attendedByPhone.get(phone) || 0) + mins);
      }

      const allPaid = await getContactsByTag(TAG_PAID);
      const gradeFieldId = await getCustomFieldIdByKey(FIELD_GRADE);
      const targetStudents = allPaid.filter(c => readById(c, gradeFieldId) === targetGrade);

      for (const student of targetStudents) {
        if (!student.id) continue;

        const phones = new Set<string>();
        if (student.phone) phones.add(normalizePhone(student.phone));
        const sp = readById(student, studentFieldId);
        const pp = readById(student, parentFieldId);
        if (sp) phones.add(normalizePhone(sp));
        if (pp) phones.add(normalizePhone(pp));

        let attendedMinutes = 0;
        for (const ph of phones) {
          if (!ph) continue;
          const m = attendedByPhone.get(ph) || 0;
          if (m > attendedMinutes) attendedMinutes = m;
        }
        const isAttended = attendedMinutes >= MIN_MINUTES;

        const toUpdate = new Map<string, any>();
        toUpdate.set(student.id, student);
        for (const ph of phones) {
          if (!ph) continue;
          const main = await findContactByPhone(ph);
          if (main?.id) toUpdate.set(main.id, main);
          for (const c of await findContactsByCustomPhone(FIELD_STUDENT_PHONE, ph)) {
            if (c.id) toUpdate.set(c.id, c);
          }
          for (const c of await findContactsByCustomPhone(FIELD_PARENT_PHONE, ph)) {
            if (c.id) toUpdate.set(c.id, c);
          }
        }

        const updatedIds: string[] = [];
        for (const c of toUpdate.values()) {
          const curTotal = Number(await getContactCustomFieldValue(c.id, FIELD_TOTAL)) || 0;
          const curAbsent = Number(await getContactCustomFieldValue(c.id, FIELD_ABSENT)) || 0;

          if (isAttended) {
            await updateContactCustomField(c.id, FIELD_TOTAL, curTotal + 1);
            // chargeable 已由原有邏輯設為 yes
          } else {
            await updateContactCustomField(c.id, FIELD_ABSENT, curAbsent + 1);
            // 今堂沒達標（包括完全沒入）→ chargeable 設為 no
            await updateContactCustomField(c.id, FIELD_CHARGEABLE, "no");
          }
          updatedIds.push(c.id);
        }

        countResults.push({
          studentId: student.id,
          grade: targetGrade,
          phones: [...phones],
          attendedMinutes,
          isAttended,
          updatedIds,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      webinarId,
      targetGrade: targetGrade || null,
      original: { count: originalResults.length, results: originalResults },
      counts: { paidStudentCount: countResults.length, results: countResults },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
