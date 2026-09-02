import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { securityHeaders } from './security.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  root = 'dist',
): void {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    securityHeaders(response, '/');
    response.writeHead(405, {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('Method not allowed');
    return;
  }

  const path = requestPath(request);
  if (path === null) {
    securityHeaders(response, '/');
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  securityHeaders(response, path);
  if (path === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(method === 'HEAD' ? undefined : 'ok');
    return;
  }

  const file = resolveFile(root, path);
  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const size = statSync(file).size;
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': size,
  });

  if (method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    response.end();
  });
  stream.pipe(response);
}

function requestPath(request: IncomingMessage): string | null {
  try {
    return decodeURIComponent(new URL(request.url ?? '/', 'http://internal').pathname);
  } catch {
    return null;
  }
}

function resolveFile(root: string, path: string): string | null {
  const requested = normalize(path).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = join(root, requested === '/' ? 'index.html' : requested);
  if (isFile(candidate)) {
    return candidate;
  }

  if (extname(path) !== '') {
    return null;
  }

  const application = join(root, 'index.html');
  return isFile(application) ? application : null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
