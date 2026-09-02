import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { sourceAddress } from '../build/server/security.js';

function request(remoteAddress: string, forwarded?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  } as unknown as IncomingMessage;
}

const trustedProxy = {
  enabled: true,
  trustedAddresses: new Set(['172.20.0.2']),
};

test('forwarding headers are accepted only from an explicitly trusted proxy', () => {
  assert.equal(sourceAddress(request('172.20.0.3', '198.51.100.1'), trustedProxy), '172.20.0.3');
  assert.equal(
    sourceAddress(request('::ffff:172.20.0.2', '198.51.100.1'), trustedProxy),
    '198.51.100.1',
  );
  assert.equal(sourceAddress(request('::ffff:172.20.0.2'), trustedProxy), '172.20.0.2');
  assert.equal(sourceAddress(request('172.20.0.2', 'not-an-address'), trustedProxy), '172.20.0.2');
  assert.equal(sourceAddress(request('172.20.0.2', '198.51.100.1')), '172.20.0.2');
});
