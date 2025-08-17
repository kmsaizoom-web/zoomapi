import { getZoomAccessToken } from "./zoomToken";
import { toIsoUTC } from "./time";

// List occurrences for a webinar
export async function listWebinarOccurrences(webinarId: string) {
  const token = await getZoomAccessToken();
  const res = await fetch(`https://api.zoom.us/v2/webinars/${encodeURIComponent(webinarId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.message || `Zoom fetch webinar ${res.status}`);
  }
  // Zoom returns occurrences under `occurrences` array
  const occ = (json?.occurrences || []) as Array<{
    occurrence_id: string;
    start_time: string; // ISO-ish
  }>;

  return occ.map(o => ({
    occurrenceId: o.occurrence_id,
    startsAtIso: toIsoUTC(o.start_time),
  }));
}

type ZoomRegistrant = {
  webinarId: string;
  occurrenceId?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
};

export async function registerZoomRegistrant(input: ZoomRegistrant) {
  const token = await getZoomAccessToken();
  const { webinarId, occurrenceId, firstName, lastName, email, phone } = input;

  const url =
    `https://api.zoom.us/v2/webinars/${encodeURIComponent(webinarId)}/registrants` +
    (occurrenceId ? `?occurrence_ids=${encodeURIComponent(occurrenceId)}` : "");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.message || `Zoom register error ${res.status}`);
  }
  // Returns join_url
  return json;
}
