export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export async function GET() {
  return new Response(JSON.stringify({ ok: true, now: new Date().toISOString() }), {
    headers: { "content-type": "application/json" }
  });
}
