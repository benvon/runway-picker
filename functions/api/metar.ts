interface MetarProxyEnv {
  METAR_API?: Fetcher;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export const onRequestGet: PagesFunction<MetarProxyEnv> = async ({ request, env }) => {
  try {
    if (!env.METAR_API) {
      return jsonError('METAR API service binding is not configured.', 500);
    }

    const requestUrl = new URL(request.url);
    const icao = requestUrl.searchParams.get('icao') ?? '';

    const workerUrl = new URL('https://metar.internal/api/metar');
    workerUrl.searchParams.set('icao', icao);

    const upstreamResponse = await env.METAR_API.fetch(
      new Request(workerUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      })
    );

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers
    });
  } catch {
    return jsonError('Unexpected error while proxying METAR lookup.', 500);
  }
};
