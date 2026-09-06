import { isEnvelope } from '../../shared/envelope.js';
import {
  TRANSPORT_VERSION,
  decodeClientFrame,
  isCredential,
  isRole,
  isRoomId,
  type ClientFrame,
  type Role,
} from '../../shared/protocol.js';
import { isEncodedEcdhPublicKey } from '../crypto.js';
import { isSessionRatchets, type SessionRatchets } from '../ratchet.js';

export const SESSION_STORAGE_KEY = 'keybridge.room.v3';
export const V2_SESSION_STORAGE_KEY = 'keybridge.room.v2';
export const LEGACY_SESSION_STORAGE_KEY = 'keybridge.room';

interface StoredCommon {
  version: typeof TRANSPORT_VERSION;
  role: Role;
  roomId: string;
  credential: string;
  attached: boolean;
  pending: ClientFrame[];
}

export type StoredSession =
  | (StoredCommon & {
      role: 'sender';
      phase: 'waiting';
      roomKey: string;
      pin: string;
    })
  | (StoredCommon & {
      role: 'sender';
      phase: 'pairing';
      roomKey: string;
      pin: string;
      receiverNonce: string;
      receiverPublicKey: string;
    })
  | (StoredCommon & {
      role: 'sender';
      phase: 'paired';
      roomKey: string;
      pin: string;
      ratchets: SessionRatchets;
    })
  | (StoredCommon & {
      role: 'receiver';
      phase: 'waiting';
      roomKey: string;
      pin: '';
    })
  | (StoredCommon & {
      role: 'receiver';
      phase: 'pairing';
      roomKey: string;
      pin: string;
      receiverNonce: string;
      receiverPublicKey: string;
      receiverPrivateKey: string;
    })
  | (StoredCommon & {
      role: 'receiver';
      phase: 'paired';
      ratchets: SessionRatchets;
    });

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadStoredSession(storage: SessionStorageLike): StoredSession | null {
  storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  storage.removeItem(V2_SESSION_STORAGE_KEY);
  const raw = storage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    storage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }

  if (!isStoredSession(value)) {
    storage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
  return value;
}

export function saveStoredSession(storage: SessionStorageLike, session: StoredSession): void {
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_STORAGE_KEY);
  storage.removeItem(V2_SESSION_STORAGE_KEY);
  storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
}

export function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  if (
    session.version !== TRANSPORT_VERSION ||
    !isRole(session.role) ||
    !isRoomId(session.roomId) ||
    !isCredential(session.credential) ||
    typeof session.attached !== 'boolean' ||
    !isPendingFrames(session.pending, session.roomId as string, session.role as Role)
  ) {
    return false;
  }

  const common = ['version', 'role', 'phase', 'roomId', 'credential', 'attached', 'pending'];
  if (session.role === 'sender') {
    if (!isRoomKey(session.roomKey) || !isPin(session.pin)) return false;
    if (session.phase === 'waiting') {
      return hasOnlyKeys(session, [...common, 'roomKey', 'pin']);
    }
    if (session.phase === 'pairing') {
      return (
        isNonce(session.receiverNonce) &&
        isEncodedEcdhPublicKey(session.receiverPublicKey) &&
        hasOnlyKeys(session, [...common, 'roomKey', 'pin', 'receiverNonce', 'receiverPublicKey'])
      );
    }
    return (
      session.phase === 'paired' &&
      isSessionRatchets(session.ratchets) &&
      hasOnlyKeys(session, [...common, 'roomKey', 'pin', 'ratchets'])
    );
  }

  if (session.phase === 'waiting') {
    return (
      isRoomKey(session.roomKey) &&
      session.pin === '' &&
      hasOnlyKeys(session, [...common, 'roomKey', 'pin'])
    );
  }
  if (session.phase === 'pairing') {
    return (
      isRoomKey(session.roomKey) &&
      isPin(session.pin) &&
      isNonce(session.receiverNonce) &&
      isEncodedEcdhPublicKey(session.receiverPublicKey) &&
      isPrivateKey(session.receiverPrivateKey) &&
      hasOnlyKeys(session, [
        ...common,
        'roomKey',
        'pin',
        'receiverNonce',
        'receiverPublicKey',
        'receiverPrivateKey',
      ])
    );
  }
  return (
    session.phase === 'paired' &&
    isSessionRatchets(session.ratchets) &&
    hasOnlyKeys(session, [...common, 'ratchets'])
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const names = new Set(allowed);
  return (
    Object.keys(value).every((key) => names.has(key)) && names.size === Object.keys(value).length
  );
}

function isPendingFrames(value: unknown, roomId: string, role: Role): value is ClientFrame[] {
  if (!Array.isArray(value) || value.length > 3) return false;
  const requestIds = new Set<string>();
  for (const raw of value) {
    const decoded = decodeClientFrame(JSON.stringify(raw));
    if (!decoded.ok || !('requestId' in decoded.value)) return false;
    const frame = decoded.value;
    if (requestIds.has(frame.requestId)) return false;
    requestIds.add(frame.requestId);
    if (frame.type === 'create' || frame.type === 'join' || frame.type === 'resume') return false;
    if ('envelope' in frame) {
      if (!isEnvelope(frame.envelope) || frame.envelope.roomId !== roomId) return false;
      if (frame.type === 'pair' && role !== 'receiver') return false;
      if ((frame.type === 'approve' || frame.type === 'item') && role !== 'sender') return false;
    }
  }
  return true;
}

function isRoomKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isPin(value: unknown): value is string {
  return typeof value === 'string' && /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(value);
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function isPrivateKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 134 &&
    value.length <= 342 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
