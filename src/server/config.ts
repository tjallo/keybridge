import { isIP } from 'node:net';
import type { ProxyTrustConfig } from './security.js';

export interface ServerConfig {
  host: string;
  port: number;
  publicOrigin: string;
  proxy: ProxyTrustConfig;
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: parseHost(environment.HOST ?? '0.0.0.0'),
    port: parsePort(environment.PORT ?? '3000'),
    publicOrigin: parsePublicOrigin(environment.PUBLIC_ORIGIN ?? 'http://localhost:3000'),
    proxy: parseProxyConfig(environment),
  };
}

function parseHost(value: string): string {
  const host = value.trim();
  if (!host || /\s/.test(host)) {
    throw new Error('HOST must be a non-empty address without whitespace');
  }
  return host;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
  return port;
}

function parsePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an absolute HTTP or HTTPS origin');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value.endsWith('/')
  ) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTP or HTTPS origin without a trailing slash');
  }

  return url.origin;
}

function parseProxyConfig(environment: NodeJS.ProcessEnv): ProxyTrustConfig {
  const trustProxy = environment.TRUST_PROXY ?? '0';
  if (trustProxy !== '0' && trustProxy !== '1') {
    throw new Error('TRUST_PROXY must be 0 or 1');
  }

  const trustedAddresses = new Set(
    (environment.TRUSTED_PROXY_ADDRESSES ?? '')
      .split(',')
      .map((address) => normalizeAddress(address.trim()))
      .filter(Boolean),
  );

  for (const address of trustedAddresses) {
    if (isIP(address) === 0) {
      throw new Error('TRUSTED_PROXY_ADDRESSES must contain IP addresses');
    }
  }

  if (trustProxy === '1' && trustedAddresses.size === 0) {
    throw new Error('TRUSTED_PROXY_ADDRESSES is required when TRUST_PROXY is 1');
  }

  return { enabled: trustProxy === '1', trustedAddresses };
}

function normalizeAddress(address: string): string {
  return address.replace(/^::ffff:/, '');
}
