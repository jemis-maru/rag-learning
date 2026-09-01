// Server-side proxy to the Express backend. Keeps BACKEND_URL (and, if you later
// move the model call here, the API key) off the browser.
const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const res = await fetch(`${BACKEND}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json(
      { error: `Cannot reach the backend at ${BACKEND}. Is it running? (${err.message})` },
      { status: 503 }
    );
  }
}
