import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, GRACE_MS, PENDING_MS, ROOM_TTL_MS } from '../build/server/rooms.js';

const senderCredential = 'S'.repeat(43);
const receiverCredential = 'R'.repeat(43);
const roomId = 'A'.repeat(22);

function room(): Room {
  return new Room(roomId, '127.0.0.1', senderCredential, 1_000);
}

function envelope(
  kind: 'pair-request' | 'pair-response' | 'item' | 'control',
  direction: 'sender-to-receiver' | 'receiver-to-sender',
  messageId: string,
  expiresAt: number | null,
) {
  return {
    version: 1 as const,
    roomId,
    messageId,
    direction,
    kind,
    expiresAt,
    nonce: 'N'.repeat(16),
    ciphertext: 'encrypted',
  };
}

function pair(roomToPair: Room, now = 1_001): void {
  roomToPair.reserve(receiverCredential, now);
  roomToPair.recordPairFrame(envelope('pair-request', 'receiver-to-sender', 'Q'.repeat(22), null));
  roomToPair.approve(
    envelope('pair-response', 'sender-to-receiver', 'P'.repeat(22), null),
    now + 1,
  );
}

test('room transitions through pairing, approval, receiver grace, and resume', () => {
  const current = room();
  assert.equal(current.state, 'WAITING');

  current.reserve(receiverCredential, 1_001);
  assert.equal(current.state, 'WAITING');

  current.disconnect('receiver', 1_002);
  assert.equal(current.state, 'RECEIVER_GRACE');
  assert.equal(current.snapshot('sender', 1_003).pairing, null);

  current.connect('receiver', receiverCredential, 1_004);
  current.recordPairFrame(envelope('pair-request', 'receiver-to-sender', 'Q'.repeat(22), null));
  assert.equal(current.state, 'PAIR_PENDING');
  assert.equal(current.snapshot('sender', 1_005).pairing?.kind, 'pair-request');

  current.approve(envelope('pair-response', 'sender-to-receiver', 'P'.repeat(22), null), 1_006);
  assert.equal(current.state, 'PAIRED');
  assert.equal(current.snapshot('receiver', 1_007).pairing?.kind, 'pair-response');
});

test('idempotent join and resume require the original receiver credential', () => {
  const current = room();
  current.reserve(receiverCredential, 1_001);
  current.reserve(receiverCredential, 1_002);

  assert.equal(current.state, 'WAITING');
  assert.throws(() => current.reserve('X'.repeat(43), 1_003), /room_unavailable/);

  current.disconnect('receiver', 1_004);
  assert.throws(() => current.connect('receiver', 'X'.repeat(43), 1_005), /room_unavailable/);
  current.connect('receiver', receiverCredential, 1_006);
  assert.equal(current.receiverConnected, true);
});

test('pairing timeout and receiver grace release the receiver slot', () => {
  const pending = room();
  pending.reserve(receiverCredential, 1_000);
  pending.tick(1_000 + PENDING_MS);
  assert.equal(pending.state, 'WAITING');
  assert.equal(pending.credentialFor('receiver'), null);

  const paired = room();
  pair(paired);
  paired.disconnect('receiver', 1_010);
  paired.tick(1_010 + GRACE_MS);
  assert.equal(paired.state, 'WAITING');
  assert.equal(paired.credentialFor('receiver'), null);
});

test('sender grace expiry and room deadline end the room', () => {
  const disconnected = room();
  disconnected.disconnect('sender', 1_000);
  disconnected.tick(1_000 + GRACE_MS);
  assert.equal(disconnected.state, 'ENDED');

  const expired = room();
  expired.tick(1_000 + ROOM_TTL_MS);
  assert.equal(expired.state, 'ENDED');
});

test('both roles reconnect in either disconnect order with independent grace', () => {
  for (const order of [
    ['sender', 'receiver'],
    ['receiver', 'sender'],
  ] as const) {
    const current = room();
    pair(current);

    current.disconnect(order[0], 1_010);
    current.disconnect(order[1], 1_020);
    assert.equal(current.state, 'SENDER_GRACE');

    current.connect('sender', senderCredential, 1_030);
    assert.equal(current.state, 'RECEIVER_GRACE');

    current.connect('receiver', receiverCredential, 1_040);
    assert.equal(current.state, 'PAIRED');
  }
});

test('items expire, revoke idempotently, and extend the room only on store', () => {
  const current = room();
  pair(current);
  const item = envelope('item', 'sender-to-receiver', 'I'.repeat(22), 2_000);

  current.store(item, 100, 1_100);
  assert.equal(current.deadline, 1_100 + ROOM_TTL_MS);
  assert.equal(current.snapshot('receiver', 1_200).items.length, 1);

  current.revoke(item.messageId);
  current.revoke(item.messageId);
  assert.equal(current.retainedBytes, 0);

  current.store({ ...item, messageId: 'J'.repeat(22) }, 100, 1_300);
  current.tick(2_000);
  assert.equal(current.items.size, 0);
});

test('request outcomes are idempotent within a role and isolated across roles', () => {
  const current = room();
  const requestId = 'D'.repeat(22);
  const senderResult = { type: 'ack', requestId, marker: 'sender' };
  const receiverResult = { type: 'ack', requestId, marker: 'receiver' };

  current.completeRequest('sender', requestId, senderResult);
  current.completeRequest('sender', requestId, { marker: 'replacement' });
  current.completeRequest('receiver', requestId, receiverResult);

  assert.deepEqual(current.requestResult('sender', requestId), senderResult);
  assert.deepEqual(current.requestResult('receiver', requestId), receiverResult);
});

test('extend cannot resurrect an expired room', () => {
  for (const now of [1_000 + ROOM_TTL_MS, 1_001 + ROOM_TTL_MS]) {
    const current = room();
    assert.throws(() => current.extend(now), /expired/);
    assert.equal(current.state, 'ENDED');
  }
});

test('end clears credentials, retained ciphertext, requests, and connections', () => {
  const current = room();
  pair(current);
  current.store(envelope('item', 'sender-to-receiver', 'I'.repeat(22), 10_000), 100, 1_100);
  current.completeRequest('sender', 'D'.repeat(22), { type: 'ack' });

  current.end();

  assert.equal(current.state, 'ENDED');
  assert.equal(current.retainedBytes, 0);
  assert.equal(current.pairingBytes, 0);
  assert.equal(current.items.size, 0);
  assert.equal(current.credentialFor('receiver'), null);
  assert.equal(current.requestResult('sender', 'D'.repeat(22)), undefined);
  assert.equal(current.senderConnected, false);
  assert.equal(current.receiverConnected, false);
});
