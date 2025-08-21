export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, now: new Date().toISOString() });
}
