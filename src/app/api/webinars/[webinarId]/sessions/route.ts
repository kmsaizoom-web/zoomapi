export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import { listWebinarOccurrences } from "@/lib/zoom";

function fmtShortLabel(iso: string): string {
  const d = new Date(iso);
  return d.toUTCString().replace(" GMT", "");
}

export async function GET(_req: NextRequest, context: { params: { webinarId: string } }) {
  const webinarId = (context.params?.webinarId || "").trim();
  if (!webinarId) {
    return new Response(JSON.stringify({ ok: false, error: "Missing webinarId" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
  try {
    const occs = await listWebinarOccurrences(webinarId);
    const out = occs.map((o) => ({
      webinarId: o.webinarId,
      occurrenceId: o.occurrenceId,
      startsAtIso: o.startsAtIso,
      label: fmtShortLabel(o.startsAtIso)
    }));
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to list sessions";
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
}
