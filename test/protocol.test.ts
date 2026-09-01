import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../build/server/protocol.js';
import { headerTuple, isEnvelope } from '../build/shared/envelope.js';
const id = 'AAAAAAAAAAAAAAAAAAAAAA';
test('protocol accepts bounded v1 create and rejects malformed or unsupported frames', () => {
  assert.equal(parseMessage('{'), null);
  assert.equal(
    parseMessage(
      JSON.stringify({ version: 2, type: 'create', roomId: id, requestId: id }),
    ),
    null,
  );
  assert.equal(
    parseMessage(
      JSON.stringify({ version: 1, type: 'create', roomId: id, requestId: id }),
    )?.type,
    'create',
  );
  assert.equal(
    parseMessage(
      JSON.stringify({
        version: 1,
        type: 'revoke',
        itemId: 'short',
        requestId: id,
      }),
    ),
    null,
  );
  assert.equal(
    parseMessage(
      JSON.stringify({ version: 1, type: 'revoke', itemId: id, requestId: id }),
    ),
    null,
  );
});
test('frozen envelope header tuple order', () => {
  const envelope = {
    version: 1 as const,
    roomId: id,
    messageId: id,
    direction: 'sender-to-receiver' as const,
    kind: 'item' as const,
    expiresAt: 123,
    nonce: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'AQID',
  };
  assert.ok(isEnvelope(envelope));
  assert.deepEqual(headerTuple(envelope), [
    1,
    id,
    id,
    'sender-to-receiver',
    'item',
    123,
    'AAAAAAAAAAAAAAAA',
  ]);
  assert.equal(
    isEnvelope({ ...envelope, ciphertext: 'x'.repeat(80_000) }),
    false,
  );
});
