// Zoom helpers with "smart" registrant reuse to avoid 429s and a simple list-occs helper.

type Json = Record<string, unknown>;

const Z_ACC = process.env.ZOOM_ACCOUNT_ID!;
const Z_ID  = process.env.ZOOM_CLIENT_ID!;
const Z_SEC = process.env.ZOOM_CLIENT_SECRET!;
if (!Z_ACC || !Z_ID || !Z_SEC) {
  throw new Error("Missing Zoom envs: ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET");
}

async function getAccessToken(): Promise<string> {
  const basic = Buffer.from(`${Z_ID}:${Z_SEC}`).toString("base64");
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(Z_ACC)}`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
  const data = await r.json();
  if (!r.ok) throw new Error(`Zoom token failed: ${r.status} ${JSON.stringify(data)}`);
  return String((data as any).access_token || "");
}

async function zoomFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`https://api.zoom.us${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

export type OccurrenceView = { webinarId: string; occurrenceId: string; startsAtIso: string };

export async function listWebinarOccurrences(webinarId: string): Promise<OccurrenceView[]> {
  const r = await zoomFetch(`/v2/webinars/${encodeURIComponent(webinarId)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(`Zoom webinar get failed: ${r.status} ${JSON.stringify(data)}`);
  const occs = Array.isArray((data as any).occurrences) ? (data as any).occurrences : [];
  return occs.map((o: any) => ({
    webinarId,
    occurrenceId: String(o.occurrence_id),
    startsAtIso: new Date(o.start_time).toISOString(),
  }));
}

// Find existing approved registrant by email for a given occurrence
export async function findRegistrantByEmail(params: {
  webinarId: string;
  occurrenceId?: string | null;
  email: string;
}): Promise<any | null> {
  const { webinarId, occurrenceId, email } = params;
  const qs = new URLSearchParams({ status: "approved", page_size: "300" });
  if (occurrenceId) qs.set("occurrence_id", occurrenceId);
  const r = await zoomFetch(`/v2/webinars/${encodeURIComponent(webinarId)}/registrants?${qs.toString()}`);
  if (!r.ok) return null;
  const data = await r.json();
  const arr: any[] = Array.isArray((data as any).registrants) ? (data as any).registrants : [];
  const needle = email.toLowerCase();
  const found = arr.find(x => String(x.email || "").toLowerCase() === needle);
  return found || null;
}

async function registerZoomRegistrantRaw(params: {
  webinarId: string;
  occurrenceId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}): Promise<any> {
  const { webinarId, occurrenceId, firstName, lastName, email, phone } = params;
  const body: any = {
    email,
    first_name: firstName,
    last_name: lastName || " ",
    occurrence_ids: occurrenceId,
  };
  if (phone) body.phone = phone;

  const r = await zoomFetch(`/v2/webinars/${encodeURIComponent(webinarId)}/registrants`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!r.ok) {
    const e: any = new Error(`Zoom register failed: ${r.status} ${JSON.stringify(json)}`);
    e.status = r.status; e.payload = json; throw e;
  }
  return json;
}

export async function registerZoomRegistrantSmart(params: {
  webinarId: string;
  occurrenceId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}): Promise<any> {
  const { webinarId, occurrenceId, email } = params;
  const existing = await findRegistrantByEmail({ webinarId, occurrenceId, email });
  if (existing?.join_url) return existing;

  try {
    return await registerZoomRegistrantRaw(params);
  } catch (e: any) {
    if (e?.status === 409 || e?.status === 400 || e?.status === 429) {
      const again = await findRegistrantByEmail({ webinarId, occurrenceId, email });
      if (again?.join_url) return again;
      if (e?.status === 429) {
        const reason = (e?.payload?.message || "Per-registrant daily limit reached");
        throw new Error(`Zoom limit: ${reason}. Please try again later.`);
      }
    }
    throw e;
  }
}
