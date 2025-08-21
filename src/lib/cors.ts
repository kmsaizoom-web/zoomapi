// Minimal CORS helpers using plain Fetch Response (no NextResponse types)

function addCorsHeaders(h: Headers) {
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function withCorsJSON(data: unknown, status = 200): Response {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}

export function withCorsText(body = "", status = 200): Response {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(body, { status, headers });
}
