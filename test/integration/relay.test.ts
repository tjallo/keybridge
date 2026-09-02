import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect as connectTcp } from 'node:net';
import WebSocket from 'ws';
import { Relay } from '../../build/server/relay.js';
import { TRANSPORT_VERSION } from '../../build/shared/protocol.js';

const id = (character: string) => character.repeat(22);
const credential = (character: string) => character.repeat(43);

function envelope(
  kind: 'pair-request' | 'pair-response' | 'item' | 'control',
  direction: 'sender-to-receiver' | 'receiver-to-sender',
  roomId: string,
  expiresAt: number | null,
  messageId = id('M'),
) {
  return {
    version: 1,
    roomId,
    messageId,
    direction,
    kind,
    expiresAt,
    nonce: 'N'.repeat(16),
    ciphertext: 'encrypted-by-browser',
  };
}

function send(socket: WebSocket, frame: object): void {
  socket.send(JSON.stringify({ version: TRANSPORT_VERSION, ...frame }));
}

function event(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', handler);
      reject(new Error(`timeout waiting for ${type}`));
    }, 2_000);

    const handler = (data: WebSocket.RawData) => {
      const value = JSON.parse(data.toString()) as Record<string, unknown>;
      if (value.type !== type) {
        return;
      }

      clearTimeout(timeout);
      socket.off('message', handler);
      resolve(value);
    };

    socket.on('message', handler);
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', resolve));
}

function connect(port: number, origin = 'http://localhost:3000'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function relayServer(): Promise<{ server: Server; relay: Relay; port: number }> {
  const server = createServer();
  const relay = new Relay(server, 'http://localhost:3000');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, relay, port: (server.address() as { port: number }).port };
}

async function attachSender(socket: WebSocket, roomId: string, token: string): Promise<void> {
  const ready = event(socket, 'ready');
  send(socket, {
    type: 'create',
    roomId,
    credential: token,
    requestId: id('C'),
  });
  assert.equal((await ready).mode, 'created');
}

async function attachReceiver(socket: WebSocket, roomId: string, token: string): Promise<void> {
  const ready = event(socket, 'ready');
  send(socket, {
    type: 'join',
    roomId,
    credential: token,
    requestId: id('J'),
  });
  assert.equal((await ready).mode, 'joined');
}

async function pair(sender: WebSocket, receiver: WebSocket, roomId: string): Promise<void> {
  const pairRequest = envelope('pair-request', 'receiver-to-sender', roomId, null, id('P'));
  const receivedPair = event(sender, 'pair_request');
  const pairAck = event(receiver, 'ack');
  send(receiver, {
    type: 'pair',
    requestId: id('1'),
    envelope: pairRequest,
  });
  await Promise.all([receivedPair, pairAck]);

  const approval = envelope('pair-response', 'sender-to-receiver', roomId, null, id('A'));
  const approved = event(receiver, 'approved');
  const approvalAck = event(sender, 'ack');
  send(sender, {
    type: 'approve',
    requestId: id('2'),
    envelope: approval,
  });
  await Promise.all([approved, approvalAck]);
}

test('relay creates, pairs, retains ciphertext, revokes, and ends a room', async (context) => {
  const { server, relay, port } = await relayServer();
  context.after(() => {
    relay.shutdown();
    server.close();
  });

  const roomId = id('A');
  const sender = await connect(port);
  const receiver = await connect(port);
  context.after(() => {
    sender.terminate();
    receiver.terminate();
  });

  await attachSender(sender, roomId, credential('S'));
  await attachReceiver(receiver, roomId, credential('R'));
  await pair(sender, receiver, roomId);

  const item = envelope('item', 'sender-to-receiver', roomId, Date.now() + 30_000, id('I'));
  const receivedItem = event(receiver, 'item');
  const itemAck = event(sender, 'ack');
  send(sender, { type: 'item', requestId: id('3'), envelope: item });
  assert.deepEqual((await receivedItem).envelope, item);
  await itemAck;
  assert.equal((relay.rooms.get(roomId)?.retainedBytes ?? 0) > 0, true);
  assert.doesNotMatch(JSON.stringify(relay.rooms.get(roomId)), /KNOWN-PLAINTEXT/);

  const control = envelope('control', 'receiver-to-sender', roomId, null, id('V'));
  const revoked = event(sender, 'revoked');
  const revokeAck = event(receiver, 'ack');
  send(receiver, {
    type: 'revoke',
    requestId: id('4'),
    itemId: id('I'),
    envelope: control,
  });
  assert.deepEqual((await revoked).envelope, control);
  await revokeAck;
  assert.equal(relay.rooms.get(roomId)?.retainedBytes, 0);

  const ended = event(receiver, 'room_ended');
  send(sender, { type: 'end', requestId: id('5') });
  await ended;
  assert.equal(relay.rooms.size, 0);
});

test('same credential replaces a half-open socket and stale close cannot disconnect it', async (context) => {
  const { server, relay, port } = await relayServer();
  context.after(() => {
    relay.shutdown();
    server.close();
  });

  const roomId = id('B');
  const token = credential('S');
  const original = await connect(port);
  await attachSender(original, roomId, token);
  const originalClosed = closed(original);

  const replacement = await connect(port);
  context.after(() => replacement.terminate());
  const ready = event(replacement, 'ready');
  send(replacement, {
    type: 'resume',
    roomId,
    role: 'sender',
    credential: token,
    requestId: id('R'),
  });
  assert.equal((await ready).mode, 'resumed');
  assert.equal(await originalClosed, 4002);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relay.rooms.get(roomId)?.senderConnected, true);

  const ack = event(replacement, 'ack');
  send(replacement, { type: 'extend', requestId: id('E') });
  assert.equal((await ack).type, 'ack');
});

test('idempotent initial create recovers when the first ready frame is lost', async (context) => {
  const { server, relay, port } = await relayServer();
  context.after(() => {
    relay.shutdown();
    server.close();
  });

  const roomId = id('C');
  const token = credential('T');
  const first = await connect(port);
  send(first, {
    type: 'create',
    roomId,
    credential: token,
    requestId: id('1'),
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('room was not created')), 2_000);
    const poll = () => {
      if (relay.rooms.has(roomId)) {
        clearTimeout(timeout);
        resolve();
      } else {
        setImmediate(poll);
      }
    };
    poll();
  });
  first.terminate();

  const second = await connect(port);
  context.after(() => second.terminate());
  const ready = event(second, 'ready');
  send(second, {
    type: 'create',
    roomId,
    credential: token,
    requestId: id('2'),
  });
  assert.equal((await ready).mode, 'resumed');
  assert.equal(relay.rooms.size, 1);
});

test('resume snapshots recover pairing request and approval frames', async (context) => {
  const { server, relay, port } = await relayServer();
  context.after(() => {
    relay.shutdown();
    server.close();
  });

  const roomId = id('D');
  const senderToken = credential('S');
  const receiverToken = credential('R');
  const sender = await connect(port);
  const receiver = await connect(port);
  await attachSender(sender, roomId, senderToken);
  await attachReceiver(receiver, roomId, receiverToken);

  sender.terminate();
  const pairRequest = envelope('pair-request', 'receiver-to-sender', roomId, null, id('P'));
  const pairAck = event(receiver, 'ack');
  send(receiver, { type: 'pair', requestId: id('1'), envelope: pairRequest });
  await pairAck;

  const resumedSender = await connect(port);
  const senderReady = event(resumedSender, 'ready');
  send(resumedSender, {
    type: 'resume',
    roomId,
    role: 'sender',
    credential: senderToken,
    requestId: id('2'),
  });
  const senderSnapshot = (await senderReady).snapshot as { pairing: unknown };
  assert.deepEqual(senderSnapshot.pairing, pairRequest);

  receiver.terminate();
  const approval = envelope('pair-response', 'sender-to-receiver', roomId, null, id('A'));
  const approvalAck = event(resumedSender, 'ack');
  send(resumedSender, { type: 'approve', requestId: id('3'), envelope: approval });
  await approvalAck;

  const resumedReceiver = await connect(port);
  context.after(() => {
    resumedSender.terminate();
    resumedReceiver.terminate();
  });
  const receiverReady = event(resumedReceiver, 'ready');
  send(resumedReceiver, {
    type: 'resume',
    roomId,
    role: 'receiver',
    credential: receiverToken,
    requestId: id('4'),
  });
  const receiverSnapshot = (await receiverReady).snapshot as { pairing: unknown };
  assert.deepEqual(receiverSnapshot.pairing, approval);
});

test('request identifiers are scoped by role across reconnect', async (context) => {
  const { server, relay, port } = await relayServer();
  context.after(() => {
    relay.shutdown();
    server.close();
  });

  const roomId = id('E');
  const sender = await connect(port);
  const receiver = await connect(port);
  context.after(() => {
    sender.terminate();
    receiver.terminate();
  });
  await attachSender(sender, roomId, credential('S'));
  await attachReceiver(receiver, roomId, credential('R'));
  await pair(sender, receiver, roomId);

  const sharedRequestId = id('X');
  const senderAck = event(sender, 'ack');
  send(sender, { type: 'extend', requestId: sharedRequestId });
  await senderAck;

  const receiverAck = event(receiver, 'ack');
  const senderRevoked = event(sender, 'revoked');
  send(receiver, {
    type: 'revoke',
    requestId: sharedRequestId,
    itemId: id('I'),
    envelope: envelope('control', 'receiver-to-sender', roomId, null, id('V')),
  });
  await Promise.all([receiverAck, senderRevoked]);
});

test('invalid room identifiers and unsupported versions receive public errors', async (context) => {
  const { server, relay, port } = await relayServer();
  context.after(() => {
    relay.shutdown();
    server.close();
  });

  for (const frame of [
    {
      version: TRANSPORT_VERSION,
      type: 'create',
      roomId: 'short',
      credential: credential('S'),
      requestId: id('R'),
    },
    {
      version: 1,
      type: 'create',
      roomId: id('F'),
      credential: credential('S'),
      requestId: id('R'),
    },
  ]) {
    const socket = await connect(port);
    const error = event(socket, 'error');
    socket.send(JSON.stringify(frame));
    const result = await error;
    assert.equal(
      result.code,
      frame.version === TRANSPORT_VERSION ? 'invalid_message' : 'unsupported_version',
    );
    socket.terminate();
  }
});

test('shutdown closes an upgraded socket that has not selected a role', async () => {
  const { server, relay, port } = await relayServer();
  const socket = await connect(port);
  const socketClosed = closed(socket);
  relay.shutdown();
  assert.equal(await socketClosed, 1001);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('malformed upgrade targets return 400 and wrong origins are rejected', async (context) => {
  const { server, relay, port } = await relayServer();
  context.after(() => {
    relay.shutdown();
    server.close();
  });

  const response = await new Promise<string>((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
    socket.on('connect', () => {
      socket.write(
        'GET //[ HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Origin: http://localhost:3000\r\n' +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n',
      );
    });
  });

  assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
  await assert.rejects(() => connect(port, 'https://wrong.example'));
});
