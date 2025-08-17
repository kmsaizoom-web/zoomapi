import { NextResponse } from "next/server";
import { findContactByPhone, extractSchoolName } from "@/lib/ghl";
import { registerZoomRegistrant } from "@/lib/zoom";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { session, phone } = body || {};
    if (!session || !phone) {
      return NextResponse.json({ error: "Missing session or phone" }, { status: 400 });
    }

    const [webinarId, occurrenceId] = String(session).split("|");
    const contact = await findContactByPhone(String(phone));
    if (!contact) {
      return NextResponse.json({ error: "Contact not found in GHL" }, { status: 404 });
    }

    const firstName = contact.firstName || "Guest";
    const lastName  = extractSchoolName(contact) || contact.lastName || "School";
    const email     = contact.email;
    const phoneNum  = contact.phone || String(phone);
    if (!email) {
      return NextResponse.json({ error: "Contact has no email in GHL" }, { status: 400 });
    }

    const result = await registerZoomRegistrant({
      webinarId,
      occurrenceId,
      firstName,
      lastName,
      email,
      phone: phoneNum,
    });

    return NextResponse.json({ join_url: result?.join_url });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Registration failed" }, { status: 500 });
  }
}
