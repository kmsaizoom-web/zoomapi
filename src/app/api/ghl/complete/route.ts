import { NextResponse } from "next/server";
import { findContactByPhone, extractSchoolName } from "@/lib/ghl";
import { registerZoomRegistrant } from "@/lib/zoom";

function parseSession(s: string): { webinarId: string; occurrenceId?: string } {
  const [webinarId, occurrenceId] = (s || "").split("|");
  if (!webinarId) throw new Error("Invalid session");
  return { webinarId, occurrenceId };
}

function firstWord(s?: string) {
  if (!s) return "Guest";
  const parts = s.trim().split(/\s+/);
  return parts[0] || "Guest";
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const session = searchParams.get("session");
    const phone = searchParams.get("phone");

    if (!session || !phone) {
      return new NextResponse("Missing session or phone", { status: 400 });
    }

    const { webinarId, occurrenceId } = parseSession(session);

    // Look up contact in GHL by phone
    const contact = await findContactByPhone(phone);
    if (!contact) {
      return new NextResponse("Contact not found in GHL", { status: 404 });
    }

    const firstName = contact.firstName ? contact.firstName : firstWord(contact?.firstName);
    const lastName  = extractSchoolName(contact) || contact.lastName || "School";
    const email     = contact.email;
    const phoneNum  = contact.phone || phone;

    if (!email) {
      return new NextResponse("Contact has no email in GHL", { status: 400 });
    }

    // Register to Zoom
    const result = await registerZoomRegistrant({
      webinarId,
      occurrenceId,
      firstName,
      lastName,
      email,
      phone: phoneNum,
    });

    const joinUrl = result?.join_url;
    if (!joinUrl) {
      return new NextResponse("Zoom did not return join_url", { status: 502 });
    }

    // 302 redirect to Zoom success URL
    return NextResponse.redirect(joinUrl, { status: 302 });
  } catch (e: any) {
    return new NextResponse(e?.message || "Registration failed", { status: 500 });
  }
}
