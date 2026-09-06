export const ENVELOPE_VERSION = 2 as const;
export const MAX_FRAME_BYTES = 95 * 1024;
export const MAX_ENVELOPE_BYTES = 72 * 1024;
export const MAX_PLAINTEXT_BYTES = 64 * 1024;
export const MAX_GENERATION = 4095;
export const MAX_FORWARD_GAP = 32;
export const MAX_SKIPPED_KEYS = 32;
export const SKIPPED_KEY_TTL_MS = 300_000;
export const ITEM_TTLS = [30, 60, 120, 300] as const;
export type Direction = 'receiver-to-sender' | 'sender-to-receiver';
export type EnvelopeKind = 'pair-request' | 'pair-response' | 'item' | 'control';

export interface EncryptedEnvelope {
  version: typeof ENVELOPE_VERSION;
  roomId: string;
  messageId: string;
  direction: Direction;
  kind: EnvelopeKind;
  expiresAt: number | null;
  generation: number | null;
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
    envelope.generation,
    envelope.nonce,
  ];
}

export function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_GENERATION;
}

export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const envelope = value as Record<string, unknown>;
  const pairing = envelope.kind === 'pair-request' || envelope.kind === 'pair-response';
  const message = envelope.kind === 'item' || envelope.kind === 'control';

  return (
    envelope.version === ENVELOPE_VERSION &&
    typeof envelope.roomId === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(envelope.roomId) &&
    typeof envelope.messageId === 'string' &&
    /^[A-Za-z0-9_-]{16,64}$/.test(envelope.messageId) &&
    (envelope.direction === 'sender-to-receiver' || envelope.direction === 'receiver-to-sender') &&
    (pairing || message) &&
    (envelope.expiresAt === null ||
      (typeof envelope.expiresAt === 'number' && Number.isSafeInteger(envelope.expiresAt))) &&
    (pairing ? envelope.generation === null : isGeneration(envelope.generation)) &&
    typeof envelope.nonce === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(envelope.nonce) &&
    typeof envelope.ciphertext === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(envelope.ciphertext) &&
    envelope.ciphertext.length <= MAX_ENVELOPE_BYTES
  );
}

export function matchesEnvelope(
  envelope: EncryptedEnvelope,
  expected: {
    roomId: string;
    direction: Direction;
    kind: EnvelopeKind;
    expiresAt: 'null' | 'present';
  },
): boolean {
  return (
    envelope.roomId === expected.roomId &&
    envelope.direction === expected.direction &&
    envelope.kind === expected.kind &&
    (expected.expiresAt === 'null' ? envelope.expiresAt === null : envelope.expiresAt !== null) &&
    (expected.kind === 'pair-request' || expected.kind === 'pair-response'
      ? envelope.generation === null
      : isGeneration(envelope.generation))
  );
}
