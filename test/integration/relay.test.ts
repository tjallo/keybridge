import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import WebSocket from 'ws';
import { Relay } from '../../build/server/relay.js';
const id = (character: string) => character.repeat(22);
const envelope = (
  kind: 'pair-request' | 'pair-response' | 'item' | 'control',
  direction: 'sender-to-receiver' | 'receiver-to-sender',
  roomId: string,
  expiresAt: number | null,
  messageId = id('M'),
) => ({
  version: 1,
  roomId,
  messageId,
  direction,
  kind,
  expiresAt,
  nonce: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'encrypted-by-browser',
});
function event(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timeout ${type}`)),
      2000,
    );
    const handler = (data: WebSocket.RawData) => {
      const value = JSON.parse(data.toString()) as Record<string, unknown>;
      if (value.type === type) {
        clearTimeout(timeout);
        socket.off('message', handler);
        resolve(value);
      }
    };
    socket.on('message', handler);
  });
}
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: 'http://localhost:3000',
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
test('relay creates, pairs one receiver, retains only ciphertext, revokes, and ends', async (t) => {
  const server = createServer();
  const relay = new Relay(server, 'http://localhost:3000');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    relay.shutdown();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const sender = await connect(port),
    receiver = await connect(port);
  t.after(() => {
    sender.terminate();
    receiver.terminate();
  });
  sender.send(
    JSON.stringify({
      version: 1,
      type: 'create',
      roomId: id('A'),
      requestId: id('R'),
    }),
  );
  const created = await event(sender, 'created');
  assert.equal(typeof created.credential, 'string');
  receiver.send(
    JSON.stringify({
      version: 1,
      type: 'join',
      roomId: id('A'),
      requestId: id('J'),
    }),
  );
  await event(receiver, 'joined');
  const second = await connect(port);
  t.after(() => second.terminate());
  second.send(
    JSON.stringify({
      version: 1,
      type: 'join',
      roomId: id('A'),
      requestId: id('K'),
    }),
  );
  assert.equal((await event(second, 'error')).code, 'room_unavailable');
  receiver.send(
    JSON.stringify({
      version: 1,
      type: 'pair',
      requestId: id('P'),
      envelope: envelope('pair-request', 'receiver-to-sender', id('A'), null),
    }),
  );
  await event(sender, 'pair_request');
  receiver.send(
    JSON.stringify({
      version: 1,
      type: 'pair',
      requestId: id('T'),
      envelope: envelope(
        'pair-request',
        'receiver-to-sender',
        id('A'),
        null,
        id('U'),
      ),
    }),
  );
  assert.equal((await event(receiver, 'error')).code, 'rate_limited');
  sender.send(
    JSON.stringify({
      version: 1,
      type: 'approve',
      requestId: id('Q'),
      envelope: envelope(
        'pair-response',
        'sender-to-receiver',
        id('A'),
        null,
        id('N'),
      ),
    }),
  );
  const approved = await event(receiver, 'approved');
  assert.equal(typeof approved.credential, 'string');
  const item = envelope(
    'item',
    'sender-to-receiver',
    id('A'),
    Date.now() + 30_000,
    id('I'),
  );
  sender.send(
    JSON.stringify({
      version: 1,
      type: 'item',
      requestId: id('S'),
      envelope: item,
    }),
  );
  assert.deepEqual((await event(receiver, 'item')).envelope, item);
  assert.equal(relay.rooms.get(id('A'))?.retainedBytes! > 0, true);
  assert.ok(
    !JSON.stringify(relay.rooms.get(id('A'))).includes('KNOWN-PLAINTEXT'),
  );
  const control = envelope(
    'control',
    'receiver-to-sender',
    id('A'),
    null,
    id('C'),
  );
  receiver.send(
    JSON.stringify({
      version: 1,
      type: 'revoke',
      requestId: id('V'),
      itemId: id('I'),
      envelope: control,
    }),
  );
  const revoked = await event(sender, 'revoked');
  assert.deepEqual(revoked.envelope, control);
  assert.equal(relay.rooms.get(id('A'))?.retainedBytes, 0);
  const receiverGrace = event(sender, 'room_state');
  receiver.terminate();
  await receiverGrace;
  const resumedReceiver = await connect(port);
  t.after(() => resumedReceiver.terminate());
  resumedReceiver.send(
    JSON.stringify({
      version: 1,
      type: 'resume',
      roomId: id('A'),
      role: 'receiver',
      credential: approved.credential,
      requestId: id('W'),
    }),
  );
  assert.deepEqual((await event(resumedReceiver, 'resumed')).items, []);
  sender.send(JSON.stringify({ version: 1, type: 'end', requestId: id('E') }));
  await event(resumedReceiver, 'room_ended');
  assert.equal(relay.rooms.size, 0);
});
test('completed mutation outcome remains idempotent across Sender reconnect', async (context) => {
  const server = createServer();
  const relay = new Relay(server, 'http://localhost:3000');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    relay.shutdown();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const sender = await connect(port);
  sender.send(
    JSON.stringify({
      version: 1,
      type: 'create',
      roomId: id('D'),
      requestId: id('1'),
    }),
  );
  const created = await event(sender, 'created');
  sender.send(
    JSON.stringify({ version: 1, type: 'extend', requestId: id('2') }),
  );
  const first = await event(sender, 'ack');
  const disconnected = new Promise<void>((resolve) =>
    sender.once('close', () => resolve()),
  );
  sender.terminate();
  await disconnected;
  const resumed = await connect(port);
  context.after(() => resumed.terminate());
  resumed.send(
    JSON.stringify({
      version: 1,
      type: 'resume',
      roomId: id('D'),
      role: 'sender',
      credential: created.credential,
      requestId: id('3'),
    }),
  );
  await event(resumed, 'resumed');
  resumed.send(
    JSON.stringify({ version: 1, type: 'extend', requestId: id('2') }),
  );
  const duplicate = await event(resumed, 'ack');
  assert.equal(duplicate.deadline, first.deadline);
  assert.equal(relay.rooms.get(id('D'))?.deadline, first.deadline);
});

test('shutdown closes an upgraded socket that has not selected a role', async () => {
  const server = createServer();
  const relay = new Relay(server, 'http://localhost:3000');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const socket = await connect(port);
  const closed = new Promise<number>((resolve) =>
    socket.once('close', resolve),
  );
  relay.shutdown();
  assert.equal(await closed, 1001);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('malformed upgrade targets return 400 without stopping the relay', async (t) => {
  const server = createServer();
  const relay = new Relay(server, 'http://localhost:3000');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    relay.shutdown();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
    socket.on('connect', () =>
      socket.write(
        'GET //[ HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Origin: http://localhost:3000\r\n' +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n',
      ),
    );
  });
  assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
  const socket = await connect(port);
  socket.terminate();
});

test('wrong Origin is rejected before upgrade', async (t) => {
  const server = createServer();
  const relay = new Relay(server, 'https://keybridge.example');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    relay.shutdown();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(() => connect(port));
});
