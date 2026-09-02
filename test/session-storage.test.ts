import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSPORT_VERSION } from '../build/shared/protocol.js';
import {
  LEGACY_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
  type SessionStorageLike,
  type StoredSession,
} from '../build/ui/session/storage.js';

class MemoryStorage implements SessionStorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    version: TRANSPORT_VERSION,
    role: 'sender',
    roomId: 'A'.repeat(22),
    roomKey: 'K'.repeat(43),
    pin: '23456789',
    credential: 'C'.repeat(43),
    attached: true,
    receiverNonce: 'R'.repeat(22),
    senderNonce: 'S'.repeat(22),
    ...overrides,
  };
}

test('storage round-trips one complete version 2 record', () => {
  const storage = new MemoryStorage();
  const value = session();
  saveStoredSession(storage, value);
  assert.deepEqual(loadStoredSession(storage), value);
});

test('storage rejects legacy, malformed, and partial records atomically', () => {
  const invalidRecords = [
    '{',
    JSON.stringify({ ...session(), version: 1 }),
    JSON.stringify({ ...session(), roomId: 'short' }),
    JSON.stringify({ ...session(), credential: 'short' }),
    JSON.stringify({ ...session(), senderNonce: 'short' }),
    JSON.stringify({ ...session(), attached: 'yes' }),
  ];

  for (const raw of invalidRecords) {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_STORAGE_KEY, raw);
    storage.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify({ role: 'sender' }));

    assert.equal(loadStoredSession(storage), null);
    assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(storage.getItem(LEGACY_SESSION_STORAGE_KEY), null);
  }
});

test('receiver record accepts an empty PIN before pairing', () => {
  const storage = new MemoryStorage();
  const value = session({
    role: 'receiver',
    pin: '',
    receiverNonce: undefined,
    senderNonce: undefined,
  });
  saveStoredSession(storage, value);
  assert.deepEqual(loadStoredSession(storage), {
    version: TRANSPORT_VERSION,
    role: 'receiver',
    roomId: value.roomId,
    roomKey: value.roomKey,
    pin: '',
    credential: value.credential,
    attached: true,
  });
});

test('clear removes current and legacy records', () => {
  const storage = new MemoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, '{}');
  storage.setItem(LEGACY_SESSION_STORAGE_KEY, '{}');
  clearStoredSession(storage);
  assert.equal(storage.values.size, 0);
});
