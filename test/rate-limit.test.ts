import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, addressGroup } from '../build/server/rate-limit.js';
test('normalizes IPv4 mapped and groups IPv6 by /64', () => {
  assert.equal(addressGroup('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(addressGroup('2001:db8:abcd:1234:1:2:3:4'), '2001:db8:abcd:1234::/64');
  assert.equal(addressGroup('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressGroup('2001:0db8:0:0::2'), addressGroup('2001:db8::1'));
  assert.equal(addressGroup('not-an-ip'), 'unknown');
});
test('connection and room creation limits', () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 20; i++) limiter.connect('a');
  assert.equal(limiter.canConnect('a'), false);
  for (let i = 0; i < 20; i++) limiter.disconnect('a');
  for (let i = 0; i < 20; i++) limiter.created('a', 1000 + i);
  assert.equal(limiter.canCreate('a', 0, 2000), 'rate_limited');
  limiter.cleanup(700_000);
  assert.equal(limiter.canCreate('a', 0, 700_000), 'ok');
  assert.equal(limiter.canCreate('a', 5, 700_000), 'rate_limited');
  for (let index = 0; index < 20; index++) assert.equal(limiter.canAttemptPairing('b', 1000), true);
  assert.equal(limiter.canAttemptPairing('b', 1000), false);
  assert.equal(limiter.canAttemptPairing('b', 700_000), true);
});
