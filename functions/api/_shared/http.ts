const API_SECURITY_HEADER_VALUES: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
};

const PASSTHROUGH_HEADER_NAMES = [
  'Content-Type',
  'Cache-Control',
  'X-Runway-Cache-Status',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'Retry-After',
  'X-Request-Id'
];

export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function appendSecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(API_SECURITY_HEADER_VALUES)) {
    headers.set(name, value);
  }
}

function appendRequestId(headers: Headers, requestId: string): void {
  headers.set('X-Request-Id', requestId);
}

export function buildApiError(message: string, status: number, code: string, requestId: string): Response {
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  appendSecurityHeaders(headers);
  appendRequestId(headers, requestId);

  return Response.json(
    {
      error: message,
      code,
      requestId
    },
    {
      status,
      headers
    }
  );
}

export function buildProxyResponse(upstreamResponse: Response, requestId: string): Response {
  const headers = new Headers();

  for (const headerName of PASSTHROUGH_HEADER_NAMES) {
    const value = upstreamResponse.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  appendSecurityHeaders(headers);
  if (!headers.get('X-Request-Id')) {
    appendRequestId(headers, requestId);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers
  });
}

export function extractClientIp(request: Request): string | null {
  const ipPattern = /^[A-Fa-f0-9:.]{3,45}$/;

  const cfConnectingIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cfConnectingIp && ipPattern.test(cfConnectingIp)) {
    return cfConnectingIp;
  }

  const xForwardedFor = request.headers.get('X-Forwarded-For');
  if (xForwardedFor) {
    const parts = xForwardedFor
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0);

    const candidate = parts[parts.length - 1];
    if (candidate && ipPattern.test(candidate)) {
      return candidate;
    }
  }

  return null;
}
