import { buildApiError, buildProxyResponse, createRequestId, extractClientIp } from './_shared/http';
import { validateIcaoParam } from './_shared/validation';

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
    const icaoValidation = validateIcaoParam(requestUrl.searchParams.get('icao'));
    if (!icaoValidation.ok) {
      return buildApiError(icaoValidation.error, 400, icaoValidation.code, requestId);
    }
    const view = requestUrl.searchParams.get('view');
    if (view !== null && view !== 'coordinates') {
      return buildApiError('Invalid airport lookup view.', 400, 'INVALID_REQUEST', requestId);
    }

    // Compatibility for the bottom stack PR: its client still uses the former
    // view query while the Worker now owns separate cache resources.
    const workerUrl = new URL(
      view === 'coordinates'
        ? 'https://metar.internal/api/airport-location'
        : 'https://metar.internal/api/airport'
    );
    workerUrl.searchParams.set('icao', icaoValidation.icao);

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
