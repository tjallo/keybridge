import type { IncomingMessage, ServerResponse } from 'node:http';
export const PUBLIC_ERRORS = [
  'busy',
  'expired',
  'invalid_message',
  'not_allowed',
  'rate_limited',
  'room_unavailable',
  'unsupported_version',
] as const;
export function securityHeaders(response: ServerResponse, path: string): void {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader(
    'Permissions-Policy',
    'accelerometer=(), ambient-light-sensor=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), speaker-selection=(), usb=(), web-share=(), xr-spatial-tracking=()',
  );
  response.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
  );
  response.setHeader(
    'Cache-Control',
    path.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-store',
  );
}
export function sourceAddress(request: IncomingMessage): string {
  const remote =
    request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
  const trusted = new Set(
    (process.env.TRUSTED_PROXY_ADDRESSES ?? '')
      .split(',')
      .map((address) => address.trim().replace(/^::ffff:/, ''))
      .filter(Boolean),
  );
  if (process.env.TRUST_PROXY === '1' && trusted.has(remote)) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string')
      return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return remote;
}
