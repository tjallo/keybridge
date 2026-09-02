import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServerConfig } from '../build/server/config.js';

test('server configuration supplies safe local defaults', () => {
  const config = loadServerConfig({});
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3000);
  assert.equal(config.publicOrigin, 'http://localhost:3000');
  assert.equal(config.proxy.enabled, false);
  assert.equal(config.proxy.trustedAddresses.size, 0);
});

test('server configuration accepts an exact origin and explicit trusted proxies', () => {
  const config = loadServerConfig({
    HOST: '127.0.0.1',
    PORT: '8080',
    PUBLIC_ORIGIN: 'https://keybridge.example',
    TRUST_PROXY: '1',
    TRUSTED_PROXY_ADDRESSES: '172.20.0.2,::ffff:192.0.2.4',
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8080);
  assert.equal(config.publicOrigin, 'https://keybridge.example');
  assert.deepEqual([...config.proxy.trustedAddresses], ['172.20.0.2', '192.0.2.4']);
});

test('server configuration rejects ambiguous or unsafe values', () => {
  const invalidEnvironments = [
    { PORT: '0' },
    { PORT: '65536' },
    { PORT: '3.5' },
    { HOST: ' ' },
    { PUBLIC_ORIGIN: 'https://keybridge.example/' },
    { PUBLIC_ORIGIN: 'https://keybridge.example/path' },
    { PUBLIC_ORIGIN: 'ftp://keybridge.example' },
    { TRUST_PROXY: 'yes' },
    { TRUST_PROXY: '1' },
    { TRUST_PROXY: '1', TRUSTED_PROXY_ADDRESSES: 'proxy.example' },
  ];

  for (const environment of invalidEnvironments) {
    assert.throws(() => loadServerConfig(environment), undefined, JSON.stringify(environment));
  }
});
