interface AirportProxyEnv {
  METAR_API?: Fetcher;
}

function jsonError(message: string, status: number, code: string): Response {
  return Response.json({ error: message, code }, { status });
}

export const onRequestGet: PagesFunction<AirportProxyEnv> = async ({ request, env }) => {
  try {
    if (!env.METAR_API) {
      return jsonError('METAR API service binding is not configured.', 500, 'SERVICE_NOT_CONFIGURED');
    }

    const requestUrl = new URL(request.url);
    const icao = requestUrl.searchParams.get('icao') ?? '';

    const workerUrl = new URL('https://metar.internal/api/airport');
    workerUrl.searchParams.set('icao', icao);

    const upstreamResponse = await env.METAR_API.fetch(
      new Request(workerUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      })
    );

    const passthroughHeaders = new Headers();
    const headerNames = ['Content-Type', 'Cache-Control', 'X-Runway-Cache-Status'];

    for (const headerName of headerNames) {
      const value = upstreamResponse.headers.get(headerName);
      if (value) {
        passthroughHeaders.set(headerName, value);
      }
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: passthroughHeaders
    });
  } catch {
    return jsonError('Unexpected error while proxying airport lookup.', 500, 'UNEXPECTED');
  }
};
