export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

export async function GET() {
  const keys = [
    "ZOOM_ACCOUNT_ID","ZOOM_CLIENT_ID","ZOOM_CLIENT_SECRET",
    "GHL_API_KEY","GHL_BASE_URL","GHL_SCHOOL_FIELD_ID"
  ];
  return NextResponse.json({
    env: Object.fromEntries(keys.map(k => [k, process.env[k] ? "SET" : "MISSING"])),
    now: new Date().toISOString()
  });
}
