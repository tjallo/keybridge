import {
  ENVELOPE_VERSION,
  headerTuple,
  type Direction,
  type EncryptedEnvelope,
  type EnvelopeKind,
} from '../shared/envelope.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const P256_PUBLIC_BYTES = 65;

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
  const limit = 256 - (256 % PIN_ALPHABET.length);
  let pin = '';

  while (pin.length < 8) {
    for (const byte of randomBytes(8 - pin.length)) {
      if (byte >= limit) continue;
      pin += PIN_ALPHABET[byte % PIN_ALPHABET.length];
    }
  }
  return pin;
}

export function normalizePin(pin: string): string {
  const value = pin.toUpperCase().replace('-', '');
  if (value.length !== 8 || [...value].some((character) => !PIN_ALPHABET.includes(character))) {
    throw new Error('PIN must contain eight allowed characters');
  }
  return value;
}

async function hkdfBits(
  input: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: string,
  length = 32,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    material,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function hkdfKey(
  input: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function derivePairingKey(
  roomKey: Uint8Array<ArrayBuffer>,
  roomId: string,
  pin: string,
): Promise<CryptoKey> {
  return hkdfKey(roomKey, encoder.encode(`${roomId}:${normalizePin(pin)}`), 'keybridge-v2/pairing');
}

export interface PairingTranscript {
  roomId: string;
  receiverNonce: string;
  receiverPublicKey: string;
  senderNonce: string;
  senderPublicKey: string;
}

export interface SessionChainSeeds {
  senderItem: string;
  senderControl: string;
  receiverControl: string;
}

export async function generateEcdhKeyPair(extractable: boolean): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, [
    'deriveBits',
  ])) as CryptoKeyPair;
}

export async function exportEcdhPublicKey(key: CryptoKey): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export async function exportEcdhPrivateKey(key: CryptoKey): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
}

export async function importEcdhPublicKey(value: string): Promise<CryptoKey> {
  const bytes = decodePublicKey(value);
  return crypto.subtle.importKey('raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export async function importEcdhPrivateKey(value: string): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid private key encoding');
  const bytes = fromBase64url(value);
  if (bytes.length < 100 || bytes.length > 256) throw new Error('Invalid private key length');
  return crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
}

export function isEncodedEcdhPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value)) return false;
  try {
    decodePublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function decodePublicKey(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error('Invalid public key encoding');
  const bytes = fromBase64url(value);
  if (bytes.length !== P256_PUBLIC_BYTES || bytes[0] !== 4) {
    throw new Error('Invalid public key');
  }
  return bytes;
}

export function pairingTranscriptBytes(transcript: PairingTranscript): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([
      ENVELOPE_VERSION,
      'keybridge-v2/session',
      transcript.roomId,
      transcript.receiverNonce,
      transcript.receiverPublicKey,
      transcript.senderNonce,
      transcript.senderPublicKey,
    ]),
  );
}

export async function deriveSessionChains(
  privateKey: CryptoKey,
  peerPublicKey: string,
  transcript: PairingTranscript,
): Promise<SessionChainSeeds> {
  const publicKey = await importEcdhPublicKey(peerPublicKey);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256),
  );
  const transcriptBytes = pairingTranscriptBytes(transcript);
  const transcriptHash = new Uint8Array(await crypto.subtle.digest('SHA-256', transcriptBytes));
  const root = await hkdfBits(shared, transcriptHash, 'keybridge-v2/session-root');

  try {
    const [senderItem, senderControl, receiverControl] = await Promise.all([
      hkdfBits(root, transcriptHash, 'keybridge-v2/chain/sender-item'),
      hkdfBits(root, transcriptHash, 'keybridge-v2/chain/sender-control'),
      hkdfBits(root, transcriptHash, 'keybridge-v2/chain/receiver-control'),
    ]);
    try {
      return {
        senderItem: base64url(senderItem),
        senderControl: base64url(senderControl),
        receiverControl: base64url(receiverControl),
      };
    } finally {
      senderItem.fill(0);
      senderControl.fill(0);
      receiverControl.fill(0);
    }
  } finally {
    shared.fill(0);
    root.fill(0);
  }
}

export async function importAesKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function deriveRatchetBytes(
  input: Uint8Array<ArrayBuffer>,
  roomId: string,
  info: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfBits(input, encoder.encode(roomId), info);
}

export async function encryptJson(
  key: CryptoKey,
  fields: {
    roomId: string;
    direction: Direction;
    kind: EnvelopeKind;
    expiresAt: number | null;
    generation: number | null;
    messageId?: string;
  },
  body: object,
): Promise<EncryptedEnvelope> {
  const nonce = randomBytes(12);
  const envelope: EncryptedEnvelope = {
    version: ENVELOPE_VERSION,
    roomId: fields.roomId,
    messageId: fields.messageId ?? randomId(),
    direction: fields.direction,
    kind: fields.kind,
    expiresAt: fields.expiresAt,
    generation: fields.generation,
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
  envelope: Pick<
    EncryptedEnvelope,
    'roomId' | 'messageId' | 'direction' | 'kind' | 'expiresAt' | 'generation'
  >,
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
      generation: envelope.generation,
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

  for (const field of [
    'roomId',
    'messageId',
    'direction',
    'kind',
    'expiresAt',
    'generation',
  ] as const) {
    if (body[field] !== envelope[field]) throw new Error('Authenticated header mismatch');
  }
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
