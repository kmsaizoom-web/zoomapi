// Server-to-Server OAuth: get access_token using account credentials
export async function getZoomAccessToken(): Promise<string> {
  const accountId = process.env.ZOOM_ACCOUNT_ID!;
  const clientId = process.env.ZOOM_CLIENT_ID!;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET!;
  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Missing Zoom env vars");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
    },
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Zoom token error: ${json?.reason || res.status}`);
  }
  return json.access_token as string;
}
