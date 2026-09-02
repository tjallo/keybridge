import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from '../build/server/static-files.js';

interface ResponseResult {
  status: number | undefined;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function get(port: number, path: string, method = 'GET'): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.once('end', () => {
        resolve({ status: response.statusCode, body, headers: response.headers });
      });
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

test('static server handles methods, routes, missing assets, HEAD, and malformed paths', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'keybridge-static-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>KeyBridge</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("ok")');

  const server = createServer((incoming, response) => serveStatic(incoming, response, root));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const port = (server.address() as { port: number }).port;

  assert.equal((await get(port, '/%C0%AF')).status, 400);
  assert.equal((await get(port, '/health')).body, 'ok');
  assert.equal((await get(port, '/rooms/example')).status, 200);
  assert.equal((await get(port, '/assets/app.js')).status, 200);
  assert.equal((await get(port, '/assets/missing.js')).status, 404);

  const head = await get(port, '/assets/app.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String('console.log("ok")'.length));

  const post = await get(port, '/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});
