import test from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePairingKey,
  deriveSessionKeys,
  encryptJson,
  decryptJson,
  generatePin,
  ReplayGuard,
} from '../src/ui/crypto.ts';
const hex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (value: ArrayBuffer) => Buffer.from(value).toString('hex');

test('PIN generation rejects bytes outside the unbiased range', () => {
  const original = crypto.getRandomValues;
  let calls = 0;
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    const bytes = array as Uint8Array;
    if (calls++ === 0) bytes.set([248, 249, 250, 251, 252, 253, 254, 255]);
    else bytes.set([0, 1, 2, 3, 4, 5, 6, 7]);
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    assert.equal(generatePin(), '23456789');
    assert.equal(calls, 2);
  } finally {
    crypto.getRandomValues = original;
  }
});

test('fixed RFC 5869 HKDF-SHA256 vector', async () => {
  const material = await crypto.subtle.importKey('raw', hex('0b'.repeat(22)), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: hex('000102030405060708090a0b0c'),
      info: hex('f0f1f2f3f4f5f6f7f8f9'),
    },
    material,
    256,
  );
  assert.equal(toHex(bits), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf');
});

test('fixed AES-256-GCM vector', async () => {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const output = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(12) },
    key,
    new Uint8Array(),
  );
  assert.equal(toHex(output), '530f8afbc74536b9a963b4f1c4cb738b');
});

test('both browsers derive matching pairing and directional session keys', async () => {
  const roomKey = new Uint8Array(32).fill(7);
  const roomId = 'AAAAAAAAAAAAAAAAAAAAAA';
  const sender = await derivePairingKey(roomKey, roomId, '2345-6789');
  const receiver = await derivePairingKey(roomKey, roomId, '23456789');
  const wrong = await derivePairingKey(roomKey, roomId, '2345678A');
  assert.deepEqual(
    Buffer.from(await crypto.subtle.exportKey('raw', sender)),
    Buffer.from(await crypto.subtle.exportKey('raw', receiver)),
  );
  assert.notDeepEqual(
    Buffer.from(await crypto.subtle.exportKey('raw', sender)),
    Buffer.from(await crypto.subtle.exportKey('raw', wrong)),
  );
  const a = await deriveSessionKeys(sender, roomId, 'receiver', 'sender');
  const b = await deriveSessionKeys(receiver, roomId, 'receiver', 'sender');
  const envelope = await encryptJson(
    a.item,
    { roomId, direction: 'sender-to-receiver', kind: 'item', expiresAt: Date.now() + 1000 },
    { sentinel: 'KNOWN-PLAINTEXT' },
  );
  assert.ok(!JSON.stringify(envelope).includes('KNOWN-PLAINTEXT'));
  assert.equal(
    (await decryptJson<{ sentinel: string }>(b.item, envelope)).sentinel,
    'KNOWN-PLAINTEXT',
  );
  await assert.rejects(() => decryptJson(a.senderControl, envelope));
  await assert.rejects(() => decryptJson(a.receiverControl, envelope));
});

test('directional control envelopes authenticate revocation identifiers', async () => {
  const pairing = await derivePairingKey(
    new Uint8Array(32).fill(9),
    'AAAAAAAAAAAAAAAAAAAAAA',
    '23456789',
  );
  const keys = await deriveSessionKeys(pairing, 'AAAAAAAAAAAAAAAAAAAAAA', 'receiver', 'sender');
  const itemId = 'IIIIIIIIIIIIIIIIIIIIII';
  const envelope = await encryptJson(
    keys.senderControl,
    {
      roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
      messageId: 'CCCCCCCCCCCCCCCCCCCCCC',
      direction: 'sender-to-receiver',
      kind: 'control',
      expiresAt: null,
    },
    { itemId },
  );
  assert.equal(envelope.messageId, 'CCCCCCCCCCCCCCCCCCCCCC');
  assert.equal(
    (await decryptJson<{ itemId: string }>(keys.senderControl, envelope)).itemId,
    itemId,
  );
  await assert.rejects(() => decryptJson(keys.receiverControl, envelope));
  await assert.rejects(() =>
    decryptJson(keys.senderControl, { ...envelope, direction: 'receiver-to-sender' }),
  );
});

test('ciphertext, AAD modification, and repeated message identifiers are rejected', async () => {
  const key = await derivePairingKey(
    new Uint8Array(32).fill(1),
    'AAAAAAAAAAAAAAAAAAAAAA',
    '23456789',
  );
  const envelope = await encryptJson(
    key,
    {
      roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
      direction: 'receiver-to-sender',
      kind: 'pair-request',
      expiresAt: null,
    },
    { proof: true },
  );
  await assert.rejects(() =>
    decryptJson(key, {
      ...envelope,
      ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1),
    }),
  );
  await assert.rejects(() => decryptJson(key, { ...envelope, direction: 'sender-to-receiver' }));
  const guard = new ReplayGuard();
  assert.equal(guard.accept(envelope.messageId), true);
  assert.equal(guard.accept(envelope.messageId), false);
});
