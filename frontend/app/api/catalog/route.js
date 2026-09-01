const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';

export async function GET() {
  try {
    const res = await fetch(`${BACKEND}/api/catalog`, { cache: 'no-store' });
    return Response.json(await res.json(), { status: res.status });
  } catch {
    // The UI degrades gracefully: no filter options, chat still works.
    return Response.json({ count: 0, genres: [], readingLevels: [] }, { status: 200 });
  }
}
