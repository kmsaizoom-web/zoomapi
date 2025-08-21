export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

import { listWebinarOccurrences } from "@/lib/zoom";

function labelFor(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: undefined
    });
  } catch { return iso; }
}

export async function GET(_: Request, ctx: { params: { webinarId: string } }) {
  const w = ctx.params.webinarId;
  if (!w) return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" }});
  const occs = await listWebinarOccurrences(w);
  const out = occs
    .map(o => ({ webinarId: w, occurrenceId: o.occurrenceId, startsAtIso: o.startsAtIso, label: labelFor(o.startsAtIso) }))
    .sort((a, b) => Date.parse(a.startsAtIso) - Date.parse(b.startsAtIso));
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "no-store" }});
}
