// Zoom OAuth + registrant helpers with "smart" reuse to avoid 429 rate limits

type Json = Record<string, any>;

const Z_ACC = process.env.ZOOM_ACCOUNT_ID!;
const Z_ID  = process.env.ZOOM_CLIENT_ID!;
const Z_SEC = process.env.ZOOM_CLIENT_SECRET!;
if (!Z_ACC || !Z_ID || !Z_SEC) throw new Error("Missing Zoom envs");

async function getAccessToken(): Promise<string> {
  const basic = Buffer.from(`${Z_ID}:${Z_SEC}`).toString("base64");
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(Z_ACC)}`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
  const data = await r.json();
  if (!r.ok) throw new Error(`Zoom token failed: ${r.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

async function zoomFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`https://api.zoom.us${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
}

export type OccurrenceView = { webinarId: string; occurrenceId: string; startsAtIso: string };

export async function listWebinarOccurrences(webinarId: string): Promise<OccurrenceView[]> {
  const r = await zoomFetch(`/v2/webinars/${encodeURIComponent(webinarId)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(`Zoom webinar get failed: ${r.status} ${JSON.stringify(data)}`);
  const occs = Array.isArray(data.occurrences) ? data.occurrences : [];
  return occs.map((o: any) => ({
    webinarId,
    occurrenceId: String(o.occurrence_id),
    startsAtIso: new Date(o.start_time).toISOString()
  }));
}

// List registrants and find by email (handles pagination)
export async function findRegistrantByEmail(params: {
  webinarId: string;
  occurrenceId?: string | null;
  email: string;
}): Promise<any | null> {
  const { webinarId, occurrenceId, email } = params;
  let pageToken = "";
  const emailL = email.toLowerCase();
  for (let round = 0; round < 10; round++) {
    const qs = new URLSearchParams({ status: "approved", page_size: "300" });
    if (occurrenceId) qs.set("occurrence_id", occurrenceId);
    if (pageToken) qs.set("next_page_token", pageToken);
    const r = await zoomFetch(`/v2/webinars/${encodeURIComponent(webinarId)}/registrants?${qs.toString()}`);
    const data = await r.json();
    if (!r.ok) return null;
    const arr: any[] = Array.isArray(data.registrants) ? data.registrants : [];
    const hit = arr.find(x => String(x.email || "").toLowerCase() === emailL);
    if (hit) return hit;
    pageToken = String(data.next_page_token || "");
    if (!pageToken) break;
  }
  return null;
}

async function registerRaw(params: {
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
    occurrence_ids: occurrenceId
  };
  if (phone) body.phone = phone;

  const r = await zoomFetch(`/v2/webinars/${encodeURIComponent(webinarId)}/registrants`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!r.ok) {
    const err: any = new Error(`Zoom register failed: ${r.status} ${JSON.stringify(json)}`);
    err.status = r.status; err.payload = json;
    throw err;
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

  // 1) reuse if already registered
  const exist = await findRegistrantByEmail({ webinarId, occurrenceId, email });
  if (exist?.join_url) return exist;

  try {
    // 2) try to create
    return await registerRaw(params);
  } catch (e: any) {
    // 3) on 409/400/429, try to reuse
    if (e?.status === 409 || e?.status === 400 || e?.status === 429) {
      const again = await findRegistrantByEmail({ webinarId, occurrenceId, email });
      if (again?.join_url) return again;
      if (e?.status === 429) {
        const reason = e?.payload?.message || "Per-registrant daily limit reached";
        throw new Error(`Zoom limit: ${reason}. Please try again later (after GMT 00:00).`);
      }
    }
    throw e;
  }
}
