import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
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
  response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.setHeader(
    'Cache-Control',
    path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
  );
}

export interface ProxyTrustConfig {
  enabled: boolean;
  trustedAddresses: ReadonlySet<string>;
}

const NO_PROXY_TRUST: ProxyTrustConfig = {
  enabled: false,
  trustedAddresses: new Set(),
};

export function sourceAddress(
  request: IncomingMessage,
  proxy: ProxyTrustConfig = NO_PROXY_TRUST,
): string {
  const remote = request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
  if (!proxy.enabled || !proxy.trustedAddresses.has(remote)) {
    return remote;
  }

  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') {
    return remote;
  }

  const source =
    forwarded
      .split(',')[0]
      ?.trim()
      .replace(/^::ffff:/, '') ?? '';
  return isIP(source) === 0 ? remote : source;
}
