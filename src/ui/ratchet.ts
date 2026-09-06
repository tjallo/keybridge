import {
  MAX_FORWARD_GAP,
  MAX_GENERATION,
  MAX_SKIPPED_KEYS,
  SKIPPED_KEY_TTL_MS,
} from '../shared/envelope.js';
import {
  base64url,
  deriveRatchetBytes,
  fromBase64url,
  importAesKey,
  type SessionChainSeeds,
} from './crypto.js';

export type RatchetChannel = 'sender-item' | 'sender-control' | 'receiver-control';

export interface SkippedMessageKey {
  generation: number;
  key: string;
  discardAt: number;
}

export interface SerializedRatchet {
  generation: number;
  key: string;
  skipped: SkippedMessageKey[];
}

export interface SessionRatchets {
  senderItem: SerializedRatchet;
  senderControl: SerializedRatchet;
  receiverControl: SerializedRatchet;
}

export interface RatchetTransition {
  key: CryptoKey;
  generation: number;
  state: SerializedRatchet;
}

export function createSessionRatchets(seeds: SessionChainSeeds): SessionRatchets {
  return {
    senderItem: createRatchet(seeds.senderItem),
    senderControl: createRatchet(seeds.senderControl),
    receiverControl: createRatchet(seeds.receiverControl),
  };
}

function createRatchet(key: string): SerializedRatchet {
  return { generation: 0, key, skipped: [] };
}

export function isSessionRatchets(value: unknown): value is SessionRatchets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ratchets = value as Record<string, unknown>;
  return (
    isSerializedRatchet(ratchets.senderItem) &&
    isSerializedRatchet(ratchets.senderControl) &&
    isSerializedRatchet(ratchets.receiverControl)
  );
}

export function isSerializedRatchet(value: unknown): value is SerializedRatchet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(state.generation) ||
    Number(state.generation) < 0 ||
    Number(state.generation) > MAX_GENERATION + 1 ||
    !isChainKey(state.key) ||
    !Array.isArray(state.skipped) ||
    state.skipped.length > MAX_SKIPPED_KEYS
  ) {
    return false;
  }

  const generations = new Set<number>();
  for (const candidate of state.skipped) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const skipped = candidate as Record<string, unknown>;
    if (
      !Number.isSafeInteger(skipped.generation) ||
      Number(skipped.generation) < 0 ||
      Number(skipped.generation) >= Number(state.generation) ||
      !isChainKey(skipped.key) ||
      !Number.isSafeInteger(skipped.discardAt) ||
      Number(skipped.discardAt) < 0 ||
      generations.has(Number(skipped.generation))
    ) {
      return false;
    }
    generations.add(Number(skipped.generation));
  }
  return true;
}

export function pruneSkippedKeys(state: SerializedRatchet, now: number): SerializedRatchet {
  const skipped = state.skipped.filter((key) => key.discardAt > now);
  return skipped.length === state.skipped.length ? state : { ...state, skipped };
}

export function pruneSessionRatchets(ratchets: SessionRatchets, now: number): SessionRatchets {
  const senderItem = pruneSkippedKeys(ratchets.senderItem, now);
  const senderControl = pruneSkippedKeys(ratchets.senderControl, now);
  const receiverControl = pruneSkippedKeys(ratchets.receiverControl, now);
  if (
    senderItem === ratchets.senderItem &&
    senderControl === ratchets.senderControl &&
    receiverControl === ratchets.receiverControl
  ) {
    return ratchets;
  }
  return { senderItem, senderControl, receiverControl };
}

export async function advanceSendRatchet(
  state: SerializedRatchet,
  roomId: string,
  channel: RatchetChannel,
): Promise<RatchetTransition | null> {
  if (state.generation > MAX_GENERATION) return null;
  const step = await deriveStep(state.key, roomId, channel, state.generation);
  return {
    key: step.messageKey,
    generation: state.generation,
    state: {
      generation: state.generation + 1,
      key: step.nextKey,
      skipped: state.skipped,
    },
  };
}

export async function prepareReceiveRatchet(
  original: SerializedRatchet,
  generation: number,
  roomId: string,
  channel: RatchetChannel,
  now: number,
): Promise<RatchetTransition | null> {
  const state = pruneSkippedKeys(original, now);
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION) {
    return null;
  }

  if (generation < state.generation) {
    const skipped = state.skipped.find((candidate) => candidate.generation === generation);
    if (!skipped) return null;
    const bytes = fromBase64url(skipped.key);
    try {
      return {
        key: await importAesKey(bytes),
        generation,
        state: {
          ...state,
          skipped: state.skipped.filter((candidate) => candidate.generation !== generation),
        },
      };
    } finally {
      bytes.fill(0);
    }
  }

  const gap = generation - state.generation;
  if (gap > MAX_FORWARD_GAP || state.skipped.length + gap > MAX_SKIPPED_KEYS) return null;

  let currentKey = state.key;
  const skipped = [...state.skipped];
  for (let candidate = state.generation; candidate <= generation; candidate += 1) {
    const step = await deriveStep(currentKey, roomId, channel, candidate);
    if (candidate === generation) {
      return {
        key: step.messageKey,
        generation,
        state: {
          generation: generation + 1,
          key: step.nextKey,
          skipped,
        },
      };
    }
    skipped.push({
      generation: candidate,
      key: step.messageKeyBytes,
      discardAt: now + SKIPPED_KEY_TTL_MS,
    });
    currentKey = step.nextKey;
  }
  return null;
}

async function deriveStep(
  encodedKey: string,
  roomId: string,
  channel: RatchetChannel,
  generation: number,
): Promise<{ messageKey: CryptoKey; messageKeyBytes: string; nextKey: string }> {
  const current = fromBase64url(encodedKey);
  try {
    const message = await deriveRatchetBytes(
      current,
      roomId,
      `keybridge-v2/ratchet/${channel}/message/${generation}`,
    );
    const next = await deriveRatchetBytes(
      current,
      roomId,
      `keybridge-v2/ratchet/${channel}/next/${generation}`,
    );
    try {
      return {
        messageKey: await importAesKey(message),
        messageKeyBytes: base64url(message),
        nextKey: base64url(next),
      };
    } finally {
      message.fill(0);
      next.fill(0);
    }
  } finally {
    current.fill(0);
  }
}

function isChainKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    return fromBase64url(value).length === 32;
  } catch {
    return false;
  }
}
