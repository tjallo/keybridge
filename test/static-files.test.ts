import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { serveStatic } from '../build/server/static-files.js';

test('malformed percent-encoded paths return 400 without terminating the server', async (context) => {
  const server = createServer((request, response) => serveStatic(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const status = await new Promise<number | undefined>((resolve, reject) => {
    get(`http://127.0.0.1:${port}/%C0%AF`, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
  assert.equal(status, 400);
  const health = await new Promise<number | undefined>((resolve, reject) => {
    get(`http://127.0.0.1:${port}/health`, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
  assert.equal(health, 200);
});
