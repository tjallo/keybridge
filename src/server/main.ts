import { createServer } from 'node:http';
import { loadServerConfig } from './config.js';
import { Relay } from './relay.js';
import { serveStatic } from './static-files.js';

const config = loadServerConfig();
const server = createServer((request, response) => serveStatic(request, response));
const relay = new Relay(server, config.publicOrigin, Date.now, config.proxy);
let stopping = false;

server.listen(config.port, config.host, () => {
  log({ event: 'relay_started', port: config.port });
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

function shutdown(): void {
  if (stopping) {
    return;
  }

  stopping = true;
  log({ event: 'relay_stopping' });
  relay.shutdown();

  const forceExit = setTimeout(() => {
    log({ event: 'relay_shutdown_timeout' });
    process.exitCode = 1;
    server.closeAllConnections();
  }, 8_000);
  forceExit.unref();

  server.close(() => {
    clearTimeout(forceExit);
  });
}

function log(event: { event: string; port?: number }): void {
  console.info(JSON.stringify(event));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
