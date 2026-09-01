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

test('forwarding headers are accepted only from an explicitly trusted proxy', () => {
  const priorTrust = process.env.TRUST_PROXY;
  const priorAddresses = process.env.TRUSTED_PROXY_ADDRESSES;
  process.env.TRUST_PROXY = '1';
  process.env.TRUSTED_PROXY_ADDRESSES = '172.20.0.2';
  try {
    assert.equal(sourceAddress(request('172.20.0.3', '198.51.100.1')), '172.20.0.3');
    assert.equal(sourceAddress(request('::ffff:172.20.0.2', '198.51.100.1')), '198.51.100.1');
  } finally {
    if (priorTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = priorTrust;
    if (priorAddresses === undefined) delete process.env.TRUSTED_PROXY_ADDRESSES;
    else process.env.TRUSTED_PROXY_ADDRESSES = priorAddresses;
  }
});
