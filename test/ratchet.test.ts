import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FORWARD_GAP,
  SKIPPED_KEY_TTL_MS,
  type EncryptedEnvelope,
} from '../build/shared/envelope.js';
import { decryptJson, encryptJson } from '../build/ui/crypto.js';
import {
  advanceSendRatchet,
  prepareReceiveRatchet,
  pruneSkippedKeys,
  type SerializedRatchet,
} from '../build/ui/ratchet.js';

const roomId = 'A'.repeat(22);
const initial = (): SerializedRatchet => ({ generation: 0, key: 'K'.repeat(43), skipped: [] });

async function send(
  state: SerializedRatchet,
  messageId: string,
): Promise<{ state: SerializedRatchet; envelope: EncryptedEnvelope }> {
  const transition = await advanceSendRatchet(state, roomId, 'sender-item');
  assert.ok(transition);
  const envelope = await encryptJson(
    transition.key,
    {
      roomId,
      messageId,
      direction: 'sender-to-receiver',
      kind: 'item',
      expiresAt: 2_000_000_000_000,
      generation: transition.generation,
    },
    { value: messageId },
  );
  return { state: transition.state, envelope };
}

async function receive(state: SerializedRatchet, envelope: EncryptedEnvelope, now = 1000) {
  assert.notEqual(envelope.generation, null);
  const transition = await prepareReceiveRatchet(
    state,
    envelope.generation!,
    roomId,
    'sender-item',
    now,
  );
  assert.ok(transition);
  const body = await decryptJson<{ value: string }>(transition.key, envelope);
  return { state: transition.state, value: body.value };
}

test('sender and receiver derive fixed matching ratchet keys', async () => {
  const sent = await send(initial(), 'M'.repeat(22));
  assert.deepEqual(await receive(initial(), sent.envelope), {
    state: sent.state,
    value: 'M'.repeat(22),
  });
  assert.deepEqual(sent.state, {
    generation: 1,
    key: 'qLy0XP0FhUnWn1sV3nAjw4QVXqUVyeH22yy1Jrb42UM',
    skipped: [],
  });
});

test('advanced chain state cannot decrypt a processed generation', async () => {
  const first = await send(initial(), 'A'.repeat(22));
  const compromised = await advanceSendRatchet(first.state, roomId, 'sender-item');
  assert.ok(compromised);
  await assert.rejects(() => decryptJson(compromised.key, first.envelope));
});

test('receiver accepts bounded reordering and deletes used skipped keys', async () => {
  const zero = await send(initial(), 'A'.repeat(22));
  const one = await send(zero.state, 'B'.repeat(22));
  const two = await send(one.state, 'C'.repeat(22));

  const receivedTwo = await receive(initial(), two.envelope);
  assert.deepEqual(
    receivedTwo.state.skipped.map((key) => key.generation),
    [0, 1],
  );
  const receivedZero = await receive(receivedTwo.state, zero.envelope);
  assert.deepEqual(
    receivedZero.state.skipped.map((key) => key.generation),
    [1],
  );
  const receivedOne = await receive(receivedZero.state, one.envelope);
  assert.deepEqual(receivedOne.state.skipped, []);
});

test('receiver rejects excessive gaps without changing state', async () => {
  const state = initial();
  assert.equal(
    await prepareReceiveRatchet(state, MAX_FORWARD_GAP + 1, roomId, 'sender-item', 1000),
    null,
  );
  assert.deepEqual(state, initial());
});

test('invalid future ciphertext does not commit candidate state', async () => {
  const zero = await send(initial(), 'A'.repeat(22));
  const one = await send(zero.state, 'B'.repeat(22));
  const state = initial();
  const transition = await prepareReceiveRatchet(state, 1, roomId, 'sender-item', 1000);
  assert.ok(transition);
  await assert.rejects(() =>
    decryptJson(transition.key, {
      ...one.envelope,
      ciphertext: `${one.envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${one.envelope.ciphertext.slice(1)}`,
    }),
  );
  assert.deepEqual(state, initial());
});

test('direction, kind, generation, and channel changes fail authentication', async () => {
  const sent = await send(initial(), 'A'.repeat(22));
  const transition = await prepareReceiveRatchet(initial(), 0, roomId, 'sender-item', 1000);
  assert.ok(transition);
  for (const changed of [
    { ...sent.envelope, direction: 'receiver-to-sender' as const },
    { ...sent.envelope, kind: 'control' as const, expiresAt: null },
    { ...sent.envelope, generation: 1 },
  ]) {
    await assert.rejects(() => decryptJson(transition.key, changed));
  }
  const wrongChannel = await prepareReceiveRatchet(initial(), 0, roomId, 'sender-control', 1000);
  assert.ok(wrongChannel);
  await assert.rejects(() => decryptJson(wrongChannel.key, sent.envelope));
});

test('skipped keys expire after five minutes', async () => {
  const zero = await send(initial(), 'A'.repeat(22));
  const one = await send(zero.state, 'B'.repeat(22));
  const received = await receive(initial(), one.envelope, 1000);
  assert.equal(received.state.skipped.length, 1);
  assert.equal(pruneSkippedKeys(received.state, 1000 + SKIPPED_KEY_TTL_MS).skipped.length, 0);
});
