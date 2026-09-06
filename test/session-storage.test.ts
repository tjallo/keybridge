import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSPORT_VERSION } from '../build/shared/protocol.js';
import {
  LEGACY_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  V2_SESSION_STORAGE_KEY,
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

const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
const chain = (key: string) => ({ generation: 0, key: key.repeat(43), skipped: [] });
const ratchets = {
  senderItem: chain('I'),
  senderControl: chain('S'),
  receiverControl: chain('R'),
};

function senderSession(): StoredSession {
  return {
    version: TRANSPORT_VERSION,
    role: 'sender',
    phase: 'paired',
    roomId: 'A'.repeat(22),
    roomKey: 'K'.repeat(43),
    pin: '23456789',
    credential: 'C'.repeat(43),
    attached: true,
    pending: [],
    ratchets,
  };
}

test('storage round-trips strict waiting, pairing, and paired records', () => {
  const records: StoredSession[] = [
    senderSession(),
    {
      version: TRANSPORT_VERSION,
      role: 'sender',
      phase: 'pairing',
      roomId: 'A'.repeat(22),
      roomKey: 'K'.repeat(43),
      pin: '23456789',
      credential: 'C'.repeat(43),
      attached: true,
      pending: [],
      receiverNonce: 'N'.repeat(22),
      receiverPublicKey: publicKey,
    },
    {
      version: TRANSPORT_VERSION,
      role: 'receiver',
      phase: 'pairing',
      roomId: 'A'.repeat(22),
      roomKey: 'K'.repeat(43),
      pin: '23456789',
      credential: 'C'.repeat(43),
      attached: true,
      pending: [],
      receiverNonce: 'N'.repeat(22),
      receiverPublicKey: publicKey,
      receiverPrivateKey: 'P'.repeat(184),
    },
    {
      version: TRANSPORT_VERSION,
      role: 'receiver',
      phase: 'paired',
      roomId: 'A'.repeat(22),
      credential: 'C'.repeat(43),
      attached: true,
      pending: [],
      ratchets,
    },
  ];

  for (const value of records) {
    const storage = new MemoryStorage();
    saveStoredSession(storage, value);
    assert.deepEqual(loadStoredSession(storage), value);
  }
});

test('storage rejects malformed and partial records atomically', () => {
  const session = senderSession();
  const invalidRecords = [
    '{',
    JSON.stringify({ ...session, version: 2 }),
    JSON.stringify({ ...session, roomId: 'short' }),
    JSON.stringify({ ...session, credential: 'short' }),
    JSON.stringify({
      ...session,
      ratchets: { ...ratchets, senderItem: { generation: 4097, key: 'I'.repeat(43), skipped: [] } },
    }),
    JSON.stringify({ ...session, attached: 'yes' }),
    JSON.stringify({ ...session, receiverPrivateKey: 'P'.repeat(184) }),
  ];

  for (const raw of invalidRecords) {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_STORAGE_KEY, raw);
    assert.equal(loadStoredSession(storage), null);
    assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
  }
});

test('load and clear remove old storage versions', () => {
  const storage = new MemoryStorage();
  storage.setItem(V2_SESSION_STORAGE_KEY, '{}');
  storage.setItem(LEGACY_SESSION_STORAGE_KEY, '{}');
  assert.equal(loadStoredSession(storage), null);
  assert.equal(storage.values.size, 0);

  storage.setItem(SESSION_STORAGE_KEY, '{}');
  storage.setItem(V2_SESSION_STORAGE_KEY, '{}');
  storage.setItem(LEGACY_SESSION_STORAGE_KEY, '{}');
  clearStoredSession(storage);
  assert.equal(storage.values.size, 0);
});
