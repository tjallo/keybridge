import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReplayGuard,
  decryptJson,
  derivePairingKey,
  deriveSessionChains,
  encryptJson,
  exportEcdhPrivateKey,
  exportEcdhPublicKey,
  generateEcdhKeyPair,
  generatePin,
  importEcdhPrivateKey,
  pairingTranscriptBytes,
} from '../build/ui/crypto.js';

const hex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (value: ArrayBuffer) => Buffer.from(value).toString('hex');
const b64 = (value: string) => Buffer.from(value, 'hex').toString('base64url');

const p1 = {
  d: b64('00'.repeat(31) + '01'),
  x: b64('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
  y: b64('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
};
const p2 = {
  d: b64('00'.repeat(31) + '02'),
  x: b64('7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978'),
  y: b64('07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1'),
};

async function privateKey(point: typeof p1): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', ext: false, key_ops: ['deriveBits'], ...point },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
}

const publicKey = (point: typeof p1) =>
  Buffer.concat([
    Buffer.from([4]),
    Buffer.from(point.x, 'base64url'),
    Buffer.from(point.y, 'base64url'),
  ]).toString('base64url');

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

test('fixed P-256 transcript derives matching channel seeds', async () => {
  const transcript = {
    roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
    receiverNonce: 'RRRRRRRRRRRRRRRRRRRRRR',
    receiverPublicKey: publicKey(p1),
    senderNonce: 'SSSSSSSSSSSSSSSSSSSSSS',
    senderPublicKey: publicKey(p2),
  };
  assert.equal(
    Buffer.from(pairingTranscriptBytes(transcript)).toString(),
    JSON.stringify([
      2,
      'keybridge-v2/session',
      transcript.roomId,
      transcript.receiverNonce,
      transcript.receiverPublicKey,
      transcript.senderNonce,
      transcript.senderPublicKey,
    ]),
  );
  const receiver = await deriveSessionChains(
    await privateKey(p1),
    transcript.senderPublicKey,
    transcript,
  );
  const sender = await deriveSessionChains(
    await privateKey(p2),
    transcript.receiverPublicKey,
    transcript,
  );
  assert.deepEqual(receiver, sender);
  assert.deepEqual(receiver, {
    senderItem: 'enlCyRAUJAZg-4e7G_6a3Usz1qi3gaPfgh5tY1V0DzA',
    senderControl: '2BqULCawo1s3TofeR3UfD2kDvx9qYCEiajLx5b4G0nI',
    receiverControl: '23K_-yNDZXLcOX8fKNGrCRBI71bl0CFvKpcyGD7-kUA',
  });

  const substituted = await deriveSessionChains(await privateKey(p1), transcript.senderPublicKey, {
    ...transcript,
    senderNonce: 'TTTTTTTTTTTTTTTTTTTTTT',
  });
  assert.notDeepEqual(substituted, receiver);
});

test('exported PKCS#8 Receiver key derives the same secret after reload', async () => {
  const receiver = await generateEcdhKeyPair(true);
  const sender = await generateEcdhKeyPair(false);
  const receiverPublicKey = await exportEcdhPublicKey(receiver.publicKey);
  const senderPublicKey = await exportEcdhPublicKey(sender.publicKey);
  const transcript = {
    roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
    receiverNonce: 'RRRRRRRRRRRRRRRRRRRRRR',
    receiverPublicKey,
    senderNonce: 'SSSSSSSSSSSSSSSSSSSSSS',
    senderPublicKey,
  };
  const stored = await exportEcdhPrivateKey(receiver.privateKey);
  const restored = await importEcdhPrivateKey(stored);
  assert.deepEqual(
    await deriveSessionChains(restored, senderPublicKey, transcript),
    await deriveSessionChains(sender.privateKey, receiverPublicKey, transcript),
  );
});

test('pairing encryption authenticates headers and generation', async () => {
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
      generation: null,
    },
    { proof: true },
  );
  assert.equal((await decryptJson<{ proof: boolean }>(key, envelope)).proof, true);
  await assert.rejects(() => decryptJson(key, { ...envelope, direction: 'sender-to-receiver' }));
  await assert.rejects(() => decryptJson(key, { ...envelope, generation: 0 }));
});

test('repeated message identifiers are rejected', () => {
  const guard = new ReplayGuard();
  assert.equal(guard.accept('M'.repeat(22)), true);
  assert.equal(guard.accept('M'.repeat(22)), false);
});
