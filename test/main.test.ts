import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('server handles SIGTERM and exits without the force timeout', async (context) => {
  const port = await availablePort();
  const child = spawn(process.execPath, ['build/server/main.js'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(() => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 3_000);
    const inspect = () => {
      if (stdout.includes('relay_started')) {
        clearTimeout(timeout);
        resolve();
      } else if (child.exitCode !== null) {
        clearTimeout(timeout);
        reject(new Error(`server exited before startup: ${stderr}`));
      } else {
        setTimeout(inspect, 10);
      }
    };
    inspect();
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.kill('SIGTERM');
  const exit = await exited;

  assert.deepEqual(exit, { code: 0, signal: null });
  assert.match(stdout, /relay_stopping/);
  assert.doesNotMatch(stdout, /relay_shutdown_timeout/);
  assert.equal(stderr, '');
});
