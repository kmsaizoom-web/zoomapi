import { NextResponse } from "next/server";
import { listWebinarOccurrences } from "@/lib/zoom";
import { isFuture, formatLabel } from "@/lib/time";

export async function GET(_: Request, { params }: { params: { webinarId: string } }) {
  try {
    const { webinarId } = params;
    if (!webinarId) return NextResponse.json({ error: "Missing webinarId" }, { status: 400 });

    const occurrences = await listWebinarOccurrences(webinarId);

    const upcoming = occurrences
      .filter(o => isFuture(o.startsAtIso))
      .sort((a, b) => new Date(a.startsAtIso).getTime() - new Date(b.startsAtIso).getTime())
      .map(o => ({
        webinarId,
        occurrenceId: o.occurrenceId,
        startsAtIso: o.startsAtIso,
        label: formatLabel(o.startsAtIso),
      }));

    return NextResponse.json(upcoming);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to fetch sessions" }, { status: 500 });
  }
}
