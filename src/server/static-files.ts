import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { securityHeaders } from './security.js';
const types: Record<string, string> = {
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
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url ?? '/', 'http://internal').pathname);
  } catch {
    securityHeaders(response, '/');
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
    return;
  }
  securityHeaders(response, path);
  if (path === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ok');
    return;
  }
  const requested = normalize(path).replace(/^(\.\.(\/|\\|$))+/, '');
  let file = join(root, requested === '/' ? 'index.html' : requested);
  try {
    if (!statSync(file).isFile()) file = join(root, 'index.html');
  } catch {
    file = join(root, 'index.html');
  }
  try {
    const size = statSync(file).size;
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Content-Length': size,
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}
