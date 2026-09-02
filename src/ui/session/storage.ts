import {
  TRANSPORT_VERSION,
  isCredential,
  isMessageId,
  isRole,
  isRoomId,
  type Role,
} from '../../shared/protocol.js';

export const SESSION_STORAGE_KEY = 'keybridge.room.v2';
export const LEGACY_SESSION_STORAGE_KEY = 'keybridge.room';

export interface StoredSession {
  version: typeof TRANSPORT_VERSION;
  role: Role;
  roomId: string;
  roomKey: string;
  pin: string;
  credential: string;
  attached: boolean;
  receiverNonce?: string;
  senderNonce?: string;
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadStoredSession(storage: SessionStorageLike): StoredSession | null {
  storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  const raw = storage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

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
  storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
}

export function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;
  if (
    session.version !== TRANSPORT_VERSION ||
    !isRole(session.role) ||
    !isRoomId(session.roomId) ||
    !isRoomKey(session.roomKey) ||
    !isPin(session.pin, session.role) ||
    !isCredential(session.credential) ||
    typeof session.attached !== 'boolean'
  ) {
    return false;
  }

  return isOptionalNonce(session.receiverNonce) && isOptionalNonce(session.senderNonce);
}

function isRoomKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isPin(value: unknown, role: Role): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  if (role === 'receiver' && value === '') {
    return true;
  }

  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(value);
}

function isOptionalNonce(value: unknown): value is string | undefined {
  return value === undefined || isMessageId(value);
}
