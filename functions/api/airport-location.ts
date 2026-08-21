import { buildApiError, buildProxyResponse, createRequestId, extractClientIp } from './_shared/http';
import { validateIcaoParam } from './_shared/validation';

interface AirportLocationProxyEnv {
  METAR_API?: Fetcher;
}

export const onRequestGet: PagesFunction<AirportLocationProxyEnv> = async ({ request, env }) => {
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

    const workerUrl = new URL('https://metar.internal/api/airport-location');
    workerUrl.searchParams.set('icao', icaoValidation.icao);
    const headers = new Headers({ Accept: 'application/json', 'X-Request-Id': requestId });
    const clientIp = extractClientIp(request);
    if (clientIp) {
      headers.set('X-Client-IP', clientIp);
    }

    return buildProxyResponse(
      await env.METAR_API.fetch(new Request(workerUrl.toString(), { method: 'GET', headers })),
      requestId
    );
  } catch {
    return buildApiError('Unexpected error while proxying airport location.', 500, 'UNEXPECTED', requestId);
  }
};
