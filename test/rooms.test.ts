import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, GRACE_MS, PENDING_MS, ROOM_TTL_MS } from '../build/server/rooms.js';
const room = () => new Room('AAAAAAAAAAAAAAAAAAAAAA', '127.0.0.1', 1000);
test('room transitions pending, reject, approve and receiver grace', () => {
  const r = room();
  assert.equal(r.state, 'WAITING');
  r.reserve(1001);
  assert.equal(r.state, 'PAIR_PENDING');
  assert.throws(() => r.reserve(1002), /room_unavailable/);
  r.reject(1003);
  r.reserve(1004);
  const credential = r.approve(1005);
  assert.equal(r.state, 'PAIRED');
  r.disconnect('receiver', 1006);
  assert.equal(r.state, 'RECEIVER_GRACE');
  r.resume('receiver', credential, 1007);
  assert.equal(r.state, 'PAIRED');
  r.disconnect('receiver', 1008);
  r.tick(1008 + GRACE_MS);
  assert.equal(r.state, 'WAITING');
});
test('pending timeout releases slot', () => {
  const r = room();
  r.reserve(1000);
  r.tick(1000 + PENDING_MS);
  assert.equal(r.state, 'WAITING');
});
test('sender grace expiry and room deadline end room', () => {
  const r = room();
  r.disconnect('sender', 1000);
  r.tick(1000 + GRACE_MS);
  assert.equal(r.state, 'ENDED');
  const second = room();
  second.tick(1000 + ROOM_TTL_MS);
  assert.equal(second.state, 'ENDED');
});
test('items expire, revoke idempotently and send extends only on store', () => {
  const r = room();
  r.reserve(1000);
  r.approve(1001);
  const envelope = {
    version: 1 as const,
    roomId: r.id,
    messageId: 'BBBBBBBBBBBBBBBBBBBBBB',
    direction: 'sender-to-receiver' as const,
    kind: 'item' as const,
    expiresAt: 2000,
    nonce: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'cipher',
  };
  r.store(envelope, 100, 1100);
  assert.equal(r.deadline, 1100 + ROOM_TTL_MS);
  assert.equal(r.snapshot(1200).length, 1);
  r.revoke(envelope.messageId);
  r.revoke(envelope.messageId);
  assert.equal(r.retainedBytes, 0);
  r.store({ ...envelope, messageId: 'CCCCCCCCCCCCCCCCCCCCCC' }, 100, 1300);
  r.tick(2000);
  assert.equal(r.items.size, 0);
});
test('sender resume restores prior active state', () => {
  const r = room();
  r.reserve(1000);
  r.approve(1001);
  r.disconnect('sender', 1002);
  r.resume('sender', r.senderCredential, 1003);
  assert.equal(r.state, 'PAIRED');
  assert.throws(() => r.resume('sender', r.senderCredential, 1004), /room_unavailable/);
});
