import { createRequestId } from './_shared/http';

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
};

export const onRequestGet: PagesFunction = async () => {
  const requestId = createRequestId();
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('X-Request-Id', requestId);

  return Response.json(
    {
      status: 'ok',
      service: 'runway-picker',
      timestamp: new Date().toISOString(),
      requestId
    },
    {
      headers
    }
  );
};
