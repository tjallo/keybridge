import { isEnvelope, type EncryptedEnvelope } from './envelope.js';

export const TRANSPORT_VERSION = 2 as const;
export const RECONNECT_GRACE_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_ALLOWANCE_MS = HEARTBEAT_INTERVAL_MS * 2;

export const PUBLIC_ERROR_CODES = [
  'busy',
  'expired',
  'invalid_message',
  'not_allowed',
  'rate_limited',
  'room_unavailable',
  'unsupported_version',
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];
export type Role = 'sender' | 'receiver';
export type RoomState = 'WAITING' | 'PAIR_PENDING' | 'PAIRED' | 'RECEIVER_GRACE' | 'SENDER_GRACE';

export interface RoomStatus {
  state: RoomState;
  deadline: number;
  senderConnected: boolean;
  receiverConnected: boolean;
}

export interface RoomSnapshot extends RoomStatus {
  items: EncryptedEnvelope[];
  pairing: EncryptedEnvelope | null;
}

interface ClientFrameBase {
  version: typeof TRANSPORT_VERSION;
}

interface RequestFrame extends ClientFrameBase {
  requestId: string;
}

export type ClientFrame =
  | (RequestFrame & { type: 'create'; roomId: string; credential: string })
  | (RequestFrame & { type: 'join'; roomId: string; credential: string })
  | (RequestFrame & { type: 'resume'; roomId: string; role: Role; credential: string })
  | (RequestFrame & { type: 'pair'; envelope: EncryptedEnvelope })
  | (RequestFrame & { type: 'approve'; envelope: EncryptedEnvelope })
  | (RequestFrame & { type: 'reject' | 'extend' | 'end' | 'leave' })
  | (RequestFrame & { type: 'item'; envelope: EncryptedEnvelope })
  | (RequestFrame & { type: 'revoke'; itemId: string; envelope: EncryptedEnvelope });

interface ServerFrameBase {
  version: typeof TRANSPORT_VERSION;
}

export type ServerFrame =
  | (ServerFrameBase & {
      type: 'ready';
      requestId: string;
      mode: 'created' | 'joined' | 'resumed';
      snapshot: RoomSnapshot;
    })
  | (ServerFrameBase & { type: 'room_state'; status: RoomStatus })
  | (ServerFrameBase & {
      type: 'pair_request';
      requestId: string;
      envelope: EncryptedEnvelope;
    })
  | (ServerFrameBase & {
      type: 'approved';
      requestId: string;
      envelope: EncryptedEnvelope;
    })
  | (ServerFrameBase & { type: 'rejected' })
  | (ServerFrameBase & { type: 'item'; envelope: EncryptedEnvelope })
  | (ServerFrameBase & {
      type: 'revoked';
      itemId: string;
      envelope: EncryptedEnvelope;
    })
  | (ServerFrameBase & {
      type: 'ack';
      requestId: string;
      status?: RoomStatus;
    })
  | (ServerFrameBase & { type: 'room_ended'; reason: string })
  | (ServerFrameBase & {
      type: 'error';
      code: PublicErrorCode;
      requestId?: string;
    });

export type FrameDecodeResult<T> =
  { ok: true; value: T } | { ok: false; code: 'invalid_message' | 'unsupported_version' };

export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

export function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export function isCredential(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isRole(value: unknown): value is Role {
  return value === 'sender' || value === 'receiver';
}

export function isPublicErrorCode(value: unknown): value is PublicErrorCode {
  return PUBLIC_ERROR_CODES.includes(value as PublicErrorCode);
}

export function decodeClientFrame(text: string): FrameDecodeResult<ClientFrame> {
  const parsed = parseJsonRecord(text);
  if (!parsed.ok) {
    return parsed;
  }

  const frame = parsed.value;
  if (frame.version !== TRANSPORT_VERSION) {
    return { ok: false, code: 'unsupported_version' };
  }

  if (typeof frame.type !== 'string' || !isMessageId(frame.requestId)) {
    return { ok: false, code: 'invalid_message' };
  }

  switch (frame.type) {
    case 'create':
    case 'join':
      if (isRoomId(frame.roomId) && isCredential(frame.credential)) {
        return acceptClientFrame(frame);
      }
      break;
    case 'resume':
      if (isRoomId(frame.roomId) && isRole(frame.role) && isCredential(frame.credential)) {
        return acceptClientFrame(frame);
      }
      break;
    case 'pair':
    case 'approve':
    case 'item':
      if (isEnvelope(frame.envelope)) {
        return acceptClientFrame(frame);
      }
      break;
    case 'reject':
    case 'extend':
    case 'end':
    case 'leave':
      return acceptClientFrame(frame);
    case 'revoke':
      if (isMessageId(frame.itemId) && isEnvelope(frame.envelope)) {
        return acceptClientFrame(frame);
      }
      break;
  }

  return { ok: false, code: 'invalid_message' };
}

export function decodeServerFrame(text: string): FrameDecodeResult<ServerFrame> {
  const parsed = parseJsonRecord(text);
  if (!parsed.ok) {
    return parsed;
  }

  const frame = parsed.value;
  if (frame.version !== TRANSPORT_VERSION) {
    return { ok: false, code: 'unsupported_version' };
  }

  if (typeof frame.type !== 'string') {
    return { ok: false, code: 'invalid_message' };
  }

  switch (frame.type) {
    case 'ready':
      if (
        isMessageId(frame.requestId) &&
        (frame.mode === 'created' || frame.mode === 'joined' || frame.mode === 'resumed') &&
        isRoomSnapshot(frame.snapshot)
      ) {
        return { ok: true, value: frame as unknown as ServerFrame };
      }
      break;
    case 'room_state':
      if (isRoomStatus(frame.status)) {
        return { ok: true, value: frame as unknown as ServerFrame };
      }
      break;
    case 'pair_request':
    case 'approved':
      if (isMessageId(frame.requestId) && isEnvelope(frame.envelope)) {
        return { ok: true, value: frame as unknown as ServerFrame };
      }
      break;
    case 'rejected':
      return { ok: true, value: frame as unknown as ServerFrame };
    case 'item':
      if (isEnvelope(frame.envelope)) {
        return { ok: true, value: frame as unknown as ServerFrame };
      }
      break;
    case 'revoked':
      if (isMessageId(frame.itemId) && isEnvelope(frame.envelope)) {
        return { ok: true, value: frame as unknown as ServerFrame };
      }
      break;
    case 'ack':
      if (
        isMessageId(frame.requestId) &&
        (frame.status === undefined || isRoomStatus(frame.status))
      ) {
        return { ok: true, value: frame as unknown as ServerFrame };
      }
      break;
    case 'room_ended':
      if (typeof frame.reason === 'string' && frame.reason.length <= 64) {
        return { ok: true, value: frame as unknown as ServerFrame };
      }
      break;
    case 'error':
      if (
        isPublicErrorCode(frame.code) &&
        (frame.requestId === undefined || isMessageId(frame.requestId))
      ) {
        return { ok: true, value: frame as unknown as ServerFrame };
      }
      break;
  }

  return { ok: false, code: 'invalid_message' };
}

function acceptClientFrame(frame: Record<string, unknown>): FrameDecodeResult<ClientFrame> {
  return { ok: true, value: frame as unknown as ClientFrame };
}

function parseJsonRecord(text: string): FrameDecodeResult<Record<string, unknown>> {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_message' };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid_message' };
  }

  return { ok: true, value: value as Record<string, unknown> };
}

function isRoomState(value: unknown): value is RoomState {
  return (
    value === 'WAITING' ||
    value === 'PAIR_PENDING' ||
    value === 'PAIRED' ||
    value === 'RECEIVER_GRACE' ||
    value === 'SENDER_GRACE'
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRoomStatus(value: unknown): value is RoomStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const status = value as Record<string, unknown>;
  return (
    isRoomState(status.state) &&
    isTimestamp(status.deadline) &&
    typeof status.senderConnected === 'boolean' &&
    typeof status.receiverConnected === 'boolean'
  );
}

function isRoomSnapshot(value: unknown): value is RoomSnapshot {
  if (!isRoomStatus(value)) {
    return false;
  }

  const snapshot = value as unknown as Record<string, unknown>;
  return (
    Array.isArray(snapshot.items) &&
    snapshot.items.length <= 10 &&
    snapshot.items.every(isEnvelope) &&
    (snapshot.pairing === null || isEnvelope(snapshot.pairing))
  );
}
