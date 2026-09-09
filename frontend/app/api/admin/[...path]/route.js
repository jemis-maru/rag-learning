/**
 * Catch-all proxy for the admin API.
 *
 * The admin token travels in a request header from the browser to this route
 * handler and is attached to the upstream call server-side. It is never baked
 * into rendered HTML or a bundled env var.
 */
const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';

async function proxy(request, params, init = {}) {
  const path = (await params).path.join('/');
  const search = new URL(request.url).search;

  try {
    const res = await fetch(`${BACKEND}/api/admin/${path}${search}`, {
      ...init,
      headers: {
        'x-admin-token': request.headers.get('x-admin-token') ?? '',
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    });

    // A catalog export comes back as a CSV/JSON attachment rather than an API
    // payload, so its content-type and filename have to survive the hop.
    const disposition = res.headers.get('content-disposition');
    if (disposition) {
      return new Response(await res.arrayBuffer(), {
        status: res.status,
        headers: {
          'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
          'content-disposition': disposition,
        },
      });
    }

    const text = await res.text();
    try {
      return Response.json(JSON.parse(text), { status: res.status });
    } catch {
      return new Response(text, { status: res.status });
    }
  } catch (err) {
    return Response.json(
      { error: `Cannot reach the backend at ${BACKEND}. Is it running? (${err.message})` },
      { status: 503 }
    );
  }
}

export async function GET(request, { params }) {
  return proxy(request, params, { method: 'GET' });
}

export async function DELETE(request, { params }) {
  return proxy(request, params, { method: 'DELETE' });
}

export async function POST(request, { params }) {
  // Uploads arrive as a raw body; everything else is small JSON. Passing the
  // ArrayBuffer straight through covers both without inspecting the payload.
  const body = await request.arrayBuffer();
  return proxy(request, params, {
    method: 'POST',
    body: body.byteLength ? body : undefined,
    headers: {
      'content-type': request.headers.get('content-type') ?? 'application/octet-stream',
    },
    duplex: 'half',
  });
}
