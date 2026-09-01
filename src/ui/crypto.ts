import {
  headerTuple,
  type Direction,
  type EncryptedEnvelope,
  type EnvelopeKind,
} from '../shared/envelope.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const PIN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(
    value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
export function randomId(bytes = 16): string {
  return base64url(randomBytes(bytes));
}
export function generatePin(): string {
  const source = randomBytes(8);
  return Array.from(source, (byte) => PIN_ALPHABET[byte % PIN_ALPHABET.length]).join('');
}
export function normalizePin(pin: string): string {
  const value = pin.toUpperCase().replace('-', '');
  if (value.length !== 8 || [...value].some((character) => !PIN_ALPHABET.includes(character)))
    throw new Error('PIN must contain eight allowed characters');
  return value;
}
async function hkdf(
  input: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: string,
  extractable = false,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}
export function derivePairingKey(
  roomKey: Uint8Array<ArrayBuffer>,
  roomId: string,
  pin: string,
): Promise<CryptoKey> {
  return hkdf(
    roomKey,
    encoder.encode(`${roomId}:${normalizePin(pin)}`),
    'keybridge-v1/pairing',
    true,
  );
}
export interface SessionKeys {
  item: CryptoKey;
  senderControl: CryptoKey;
  receiverControl: CryptoKey;
}
export async function deriveSessionKeys(
  pairingKey: CryptoKey,
  roomId: string,
  receiverNonce: string,
  senderNonce: string,
): Promise<SessionKeys> {
  const pairingBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pairingKey));
  const root = await hkdf(
    pairingBytes,
    encoder.encode(`${roomId}/${receiverNonce}/${senderNonce}`),
    'keybridge-v1/session-root',
    true,
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', root));
  return {
    item: await hkdf(raw, encoder.encode(roomId), 'keybridge-v1/sender-to-receiver/item'),
    senderControl: await hkdf(
      raw,
      encoder.encode(roomId),
      'keybridge-v1/sender-to-receiver/control',
    ),
    receiverControl: await hkdf(
      raw,
      encoder.encode(roomId),
      'keybridge-v1/receiver-to-sender/control',
    ),
  };
}
export async function encryptJson(
  key: CryptoKey,
  fields: {
    roomId: string;
    direction: Direction;
    kind: EnvelopeKind;
    expiresAt: number | null;
    messageId?: string;
  },
  body: object,
): Promise<EncryptedEnvelope> {
  const nonce = randomBytes(12);
  const envelope: EncryptedEnvelope = {
    version: 1,
    roomId: fields.roomId,
    messageId: fields.messageId ?? randomId(),
    direction: fields.direction,
    kind: fields.kind,
    expiresAt: fields.expiresAt,
    nonce: base64url(nonce),
    ciphertext: '',
  };
  const plaintext = encodePlaintext(envelope, body);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: encoder.encode(JSON.stringify(headerTuple(envelope))),
    },
    key,
    plaintext,
  );
  envelope.ciphertext = base64url(new Uint8Array(encrypted));
  return envelope;
}
export function encodePlaintext(
  envelope: Pick<EncryptedEnvelope, 'roomId' | 'messageId' | 'direction' | 'kind' | 'expiresAt'>,
  body: object,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify({
      ...body,
      roomId: envelope.roomId,
      messageId: envelope.messageId,
      direction: envelope.direction,
      kind: envelope.kind,
      expiresAt: envelope.expiresAt,
    }),
  );
}

export async function decryptJson<T>(key: CryptoKey, envelope: EncryptedEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64url(envelope.nonce),
      additionalData: encoder.encode(JSON.stringify(headerTuple(envelope))),
    },
    key,
    fromBase64url(envelope.ciphertext),
  );
  const body = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
  for (const field of ['roomId', 'messageId', 'direction', 'kind', 'expiresAt'] as const)
    if (body[field] !== envelope[field]) throw new Error('Authenticated header mismatch');
  return body as T;
}
export class ReplayGuard {
  readonly #seen = new Set<string>();
  has(id: string): boolean {
    return this.#seen.has(id);
  }
  commit(id: string): boolean {
    if (this.#seen.has(id) || this.#seen.size >= 4096) return false;
    this.#seen.add(id);
    return true;
  }
  accept(id: string): boolean {
    return this.commit(id);
  }
}
