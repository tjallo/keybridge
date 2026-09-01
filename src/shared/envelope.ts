export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 95 * 1024;
export const MAX_ENVELOPE_BYTES = 72 * 1024;
export const MAX_PLAINTEXT_BYTES = 64 * 1024;
export const ITEM_TTLS = [30, 60, 120, 300] as const;
export type Direction = 'receiver-to-sender' | 'sender-to-receiver';
export type EnvelopeKind = 'pair-request' | 'pair-response' | 'item' | 'control';

/** Public authenticated fields. Tuple order is frozen for protocol version 1. */
export interface EncryptedEnvelope {
  version: 1;
  roomId: string;
  messageId: string;
  direction: Direction;
  kind: EnvelopeKind;
  expiresAt: number | null;
  nonce: string;
  ciphertext: string;
}

export function headerTuple(envelope: EncryptedEnvelope): readonly unknown[] {
  return [
    envelope.version,
    envelope.roomId,
    envelope.messageId,
    envelope.direction,
    envelope.kind,
    envelope.expiresAt,
    envelope.nonce,
  ];
}

export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    e.version === PROTOCOL_VERSION &&
    typeof e.roomId === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(e.roomId) &&
    typeof e.messageId === 'string' &&
    /^[A-Za-z0-9_-]{16,64}$/.test(e.messageId) &&
    (e.direction === 'sender-to-receiver' || e.direction === 'receiver-to-sender') &&
    ['pair-request', 'pair-response', 'item', 'control'].includes(String(e.kind)) &&
    (e.expiresAt === null ||
      (typeof e.expiresAt === 'number' && Number.isSafeInteger(e.expiresAt))) &&
    typeof e.nonce === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(e.nonce) &&
    typeof e.ciphertext === 'string' &&
    e.ciphertext.length <= MAX_ENVELOPE_BYTES
  );
}
