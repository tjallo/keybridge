import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { Relay } from '../../build/server/relay.js';
const id = (character: string) => character.repeat(22);
const envelope = (
  kind: 'pair-request' | 'pair-response' | 'item',
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
function event(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout ${type}`)), 2000);
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://localhost:3000' });
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
  sender.send(JSON.stringify({ version: 1, type: 'create', roomId: id('A'), requestId: id('R') }));
  const created = await event(sender, 'created');
  assert.equal(typeof created.credential, 'string');
  receiver.send(JSON.stringify({ version: 1, type: 'join', roomId: id('A'), requestId: id('J') }));
  await event(receiver, 'joined');
  const second = await connect(port);
  t.after(() => second.terminate());
  second.send(JSON.stringify({ version: 1, type: 'join', roomId: id('A'), requestId: id('K') }));
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
  sender.send(
    JSON.stringify({
      version: 1,
      type: 'approve',
      requestId: id('Q'),
      envelope: envelope('pair-response', 'sender-to-receiver', id('A'), null, id('N')),
    }),
  );
  const approved = await event(receiver, 'approved');
  assert.equal(typeof approved.credential, 'string');
  const item = envelope('item', 'sender-to-receiver', id('A'), Date.now() + 30_000, id('I'));
  sender.send(JSON.stringify({ version: 1, type: 'item', requestId: id('S'), envelope: item }));
  assert.deepEqual((await event(receiver, 'item')).envelope, item);
  assert.equal(relay.rooms.get(id('A'))?.retainedBytes! > 0, true);
  assert.ok(!JSON.stringify(relay.rooms.get(id('A'))).includes('KNOWN-PLAINTEXT'));
  receiver.send(
    JSON.stringify({ version: 1, type: 'revoke', requestId: id('V'), itemId: id('I') }),
  );
  await event(sender, 'revoked');
  assert.equal(relay.rooms.get(id('A'))?.retainedBytes, 0);
  sender.send(JSON.stringify({ version: 1, type: 'end', requestId: id('E') }));
  await event(receiver, 'room_ended');
  assert.equal(relay.rooms.size, 0);
});
test('wrong Origin is rejected before upgrade', async (t) => {
  const server = createServer();
  const relay = new Relay(server, 'https://keybridge.tjallo.nl');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    relay.shutdown();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(() => connect(port));
});
