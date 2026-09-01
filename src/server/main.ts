import { createServer } from 'node:http';
import { Relay } from './relay.js';
import { serveStatic } from './static-files.js';
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000';
const server = createServer((request, response) => serveStatic(request, response));
const relay = new Relay(server, origin);
server.listen(port, host, () => console.info(JSON.stringify({ event: 'relay_started', port })));
let stopping = false;

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  console.info(JSON.stringify({ event: 'relay_stopping' }));
  relay.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
