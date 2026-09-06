import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVELOPE_VERSION,
  headerTuple,
  isEnvelope,
  type EncryptedEnvelope,
} from '../build/shared/envelope.js';
import {
  PUBLIC_ERROR_CODES,
  TRANSPORT_VERSION,
  decodeClientFrame,
  decodeServerFrame,
} from '../build/shared/protocol.js';

const roomId = 'A'.repeat(22);
const requestId = 'R'.repeat(22);
const credential = 'C'.repeat(43);

function envelope(overrides: Partial<EncryptedEnvelope> = {}): EncryptedEnvelope {
  return {
    version: ENVELOPE_VERSION,
    roomId,
    messageId: 'M'.repeat(22),
    direction: 'sender-to-receiver',
    kind: 'item',
    expiresAt: 1_700_000_000_000,
    generation: 0,
    nonce: 'N'.repeat(16),
    ciphertext: 'AQID',
    ...overrides,
  };
}

function client(frame: object) {
  return decodeClientFrame(JSON.stringify({ version: TRANSPORT_VERSION, requestId, ...frame }));
}

function server(frame: object) {
  return decodeServerFrame(JSON.stringify({ version: TRANSPORT_VERSION, ...frame }));
}

const status = {
  state: 'PAIRED',
  deadline: 1_700_000_000_000,
  senderConnected: true,
  receiverConnected: true,
} as const;

test('transport and encrypted envelope versions are independent', () => {
  assert.equal(TRANSPORT_VERSION, 3);
  assert.equal(ENVELOPE_VERSION, 2);
});

test('client decoder accepts every version 3 command', () => {
  const commands = [
    { type: 'create', roomId, credential },
    { type: 'join', roomId, credential },
    { type: 'resume', roomId, role: 'sender', credential },
    {
      type: 'pair',
      envelope: envelope({
        direction: 'receiver-to-sender',
        kind: 'pair-request',
        expiresAt: null,
        generation: null,
      }),
    },
    {
      type: 'approve',
      envelope: envelope({ kind: 'pair-response', expiresAt: null, generation: null }),
    },
    { type: 'reject' },
    { type: 'extend' },
    { type: 'end' },
    { type: 'leave' },
    { type: 'item', envelope: envelope() },
    {
      type: 'revoke',
      itemId: 'I'.repeat(22),
      envelope: envelope({ kind: 'control', expiresAt: null, generation: 0 }),
    },
  ];

  for (const command of commands) {
    const result = client(command);
    assert.equal(result.ok, true, command.type);
    if (result.ok) {
      assert.equal(result.value.type, command.type);
    }
  }
});

test('server decoder accepts every version 3 event', () => {
  const events = [
    {
      type: 'ready',
      requestId,
      mode: 'resumed',
      snapshot: { ...status, items: [envelope()], pairing: null },
    },
    { type: 'room_state', status },
    { type: 'pair_request', requestId, envelope: envelope() },
    { type: 'approved', requestId, envelope: envelope() },
    { type: 'rejected' },
    { type: 'item', envelope: envelope() },
    { type: 'revoked', itemId: 'I'.repeat(22), envelope: envelope() },
    { type: 'ack', requestId, status },
    { type: 'room_ended', reason: 'expired' },
    { type: 'error', code: 'rate_limited', requestId },
  ];

  for (const event of events) {
    const result = server(event);
    assert.equal(result.ok, true, event.type);
    if (result.ok) {
      assert.equal(result.value.type, event.type);
    }
  }
});

test('decoders distinguish malformed frames from unsupported versions', () => {
  assert.deepEqual(decodeClientFrame('{'), { ok: false, code: 'invalid_message' });
  assert.deepEqual(decodeServerFrame('[]'), { ok: false, code: 'invalid_message' });
  for (const version of [1, 2]) {
    assert.deepEqual(
      decodeClientFrame(JSON.stringify({ version, type: 'create', requestId, roomId, credential })),
      { ok: false, code: 'unsupported_version' },
    );
  }
  for (const version of [1, 2]) {
    assert.deepEqual(decodeServerFrame(JSON.stringify({ version, type: 'rejected' })), {
      ok: false,
      code: 'unsupported_version',
    });
  }
});

test('client decoder rejects invalid identifiers, credentials, and envelopes', () => {
  assert.equal(client({ type: 'create', roomId: 'short', credential }).ok, false);
  assert.equal(client({ type: 'create', roomId, credential: 'short' }).ok, false);
  assert.equal(
    decodeClientFrame(
      JSON.stringify({
        version: TRANSPORT_VERSION,
        type: 'create',
        requestId: 'short',
        roomId,
        credential,
      }),
    ).ok,
    false,
  );
  assert.equal(client({ type: 'item', envelope: { ...envelope(), ciphertext: '*' } }).ok, false);
  assert.equal(
    client({
      type: 'item',
      envelope: { ...envelope(), ciphertext: 'x'.repeat(80_000) },
    }).ok,
    false,
  );
});

test('server decoder rejects malformed snapshots and unknown public errors', () => {
  assert.equal(
    server({
      type: 'ready',
      requestId,
      mode: 'resumed',
      snapshot: { ...status, items: Array(11).fill(envelope()), pairing: null },
    }).ok,
    false,
  );
  assert.equal(server({ type: 'room_state', status: { ...status, deadline: -1 } }).ok, false);
  assert.equal(server({ type: 'error', code: 'internal_error' }).ok, false);

  for (const code of PUBLIC_ERROR_CODES) {
    assert.equal(server({ type: 'error', code }).ok, true, code);
  }
});

test('encrypted envelope version 2 authenticates the ratchet generation', () => {
  const value = envelope();
  assert.ok(isEnvelope(value));
  assert.deepEqual(headerTuple(value), [
    2,
    roomId,
    'M'.repeat(22),
    'sender-to-receiver',
    'item',
    1_700_000_000_000,
    0,
    'N'.repeat(16),
  ]);
  assert.equal(isEnvelope({ ...value, version: 1 }), false);
  assert.equal(isEnvelope({ ...value, generation: 4096 }), false);
  assert.equal(isEnvelope({ ...value, generation: null }), false);
  assert.equal(
    isEnvelope({ ...value, kind: 'pair-request', expiresAt: null, generation: null }),
    true,
  );
  assert.equal(isEnvelope({ ...value, kind: 'pair-request', generation: 0 }), false);
});
