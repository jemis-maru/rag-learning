const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';

export async function GET() {
  try {
    const res = await fetch(`${BACKEND}/api/health`, { cache: 'no-store' });
    return Response.json(await res.json(), { status: res.status });
  } catch {
    // The chat page uses this only for the pipeline badges, so degrade quietly.
    return Response.json({ ok: false, indexReady: false }, { status: 200 });
  }
}
