import { buildApiError, buildProxyResponse, createRequestId, extractClientIp } from './_shared/http';

interface AirportProxyEnv {
  METAR_API?: Fetcher;
}

export const onRequestGet: PagesFunction<AirportProxyEnv> = async ({ request, env }) => {
  const requestId = createRequestId();

  try {
    if (!env.METAR_API) {
      return buildApiError('METAR API service binding is not configured.', 500, 'SERVICE_NOT_CONFIGURED', requestId);
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.has('view')) {
      return buildApiError('Airport lookup does not support a view parameter.', 400, 'INVALID_REQUEST', requestId);
    }

    const workerUrl = new URL('https://metar.internal/api/airport');
    const icao = requestUrl.searchParams.get('icao');
    if (icao !== null) {
      workerUrl.searchParams.set('icao', icao);
    }

    const headers = new Headers({
      Accept: 'application/json',
      'X-Request-Id': requestId
    });

    const clientIp = extractClientIp(request);
    if (clientIp) {
      headers.set('X-Client-IP', clientIp);
    }

    const upstreamResponse = await env.METAR_API.fetch(
      new Request(workerUrl.toString(), {
        method: 'GET',
        headers
      })
    );

    return buildProxyResponse(upstreamResponse, requestId);
  } catch {
    return buildApiError('Unexpected error while proxying airport lookup.', 500, 'UNEXPECTED', requestId);
  }
};
