import { randomBytes } from 'node:crypto';
import type { EncryptedEnvelope } from '../shared/envelope.js';

export type RoomState =
  'WAITING' | 'PAIR_PENDING' | 'PAIRED' | 'RECEIVER_GRACE' | 'SENDER_GRACE' | 'ENDED';
export const ROOM_TTL_MS = 600_000,
  GRACE_MS = 60_000,
  PENDING_MS = 60_000;
const MAX_ITEMS = 10,
  MAX_ROOM_BYTES = 256 * 1024,
  MAX_ROOM_COMMANDS = 4096;
const token = () => randomBytes(24).toString('base64url');
export interface StoredItem {
  envelope: EncryptedEnvelope;
  bytes: number;
}
type ActiveState = 'WAITING' | 'PAIR_PENDING' | 'PAIRED';

export class Room {
  readonly id: string;
  readonly addressGroup: string;
  readonly senderCredential = token();
  deadline: number;
  activeState: ActiveState = 'WAITING';
  ended = false;
  senderConnected = true;
  receiverConnected = false;
  senderGraceUntil: number | null = null;
  receiverGraceUntil: number | null = null;
  receiverCredential: string | null = null;
  pendingSince: number | null = null;
  readonly items = new Map<string, StoredItem>();
  readonly requests = new Map<string, unknown>();
  retainedBytes = 0;
  pendingAttempts = 0;
  pairFrames = 0;

  constructor(id: string, addressGroup: string, now: number) {
    this.id = id;
    this.addressGroup = addressGroup;
    this.deadline = now + ROOM_TTL_MS;
  }

  get state(): RoomState {
    if (this.ended) return 'ENDED';
    if (!this.senderConnected) return 'SENDER_GRACE';
    if (this.activeState === 'PAIRED' && !this.receiverConnected) return 'RECEIVER_GRACE';
    return this.activeState;
  }

  reserve(now: number): void {
    this.tick(now);
    if (this.state !== 'WAITING') throw new Error('room_unavailable');
    if (this.pendingAttempts >= 10) throw new Error('rate_limited');
    this.pendingAttempts++;
    this.pairFrames = 0;
    this.activeState = 'PAIR_PENDING';
    this.receiverConnected = true;
    this.pendingSince = now;
  }

  recordPairFrame(): void {
    if (this.activeState !== 'PAIR_PENDING' || !this.receiverConnected)
      throw new Error('not_allowed');
    if (this.pairFrames >= 1) throw new Error('rate_limited');
    this.pairFrames++;
  }

  reject(now: number): void {
    if (this.activeState !== 'PAIR_PENDING') throw new Error('not_allowed');
    this.activeState = 'WAITING';
    this.pendingSince = null;
    this.receiverConnected = false;
    this.receiverCredential = null;
    this.tick(now);
  }

  approve(now: number): string {
    this.tick(now);
    if (this.activeState !== 'PAIR_PENDING' || !this.receiverConnected)
      throw new Error('not_allowed');
    this.activeState = 'PAIRED';
    this.pendingSince = null;
    return (this.receiverCredential = token());
  }

  disconnect(role: 'sender' | 'receiver', now: number): void {
    if (this.ended) return;
    if (role === 'sender') {
      if (!this.senderConnected) return;
      this.senderConnected = false;
      this.senderGraceUntil = now + GRACE_MS;
      return;
    }
    if (!this.receiverConnected) return;
    this.receiverConnected = false;
    if (this.activeState === 'PAIR_PENDING') this.reject(now);
    else if (this.activeState === 'PAIRED') this.receiverGraceUntil = now + GRACE_MS;
  }

  resume(role: 'sender' | 'receiver', credential: string, now: number): void {
    this.tick(now);
    if (role === 'sender') {
      if (credential !== this.senderCredential || this.senderConnected || this.ended)
        throw new Error('room_unavailable');
      this.senderConnected = true;
      this.senderGraceUntil = null;
      return;
    }
    if (
      credential !== this.receiverCredential ||
      this.receiverConnected ||
      this.activeState !== 'PAIRED' ||
      this.ended
    )
      throw new Error('room_unavailable');
    this.receiverConnected = true;
    this.receiverGraceUntil = null;
  }

  extend(now: number): void {
    this.tick(now);
    if (this.ended) throw new Error('expired');
    this.deadline = now + ROOM_TTL_MS;
  }

  store(envelope: EncryptedEnvelope, bytes: number, now: number): void {
    this.tick(now);
    if (this.state !== 'PAIRED') throw new Error('not_allowed');
    if (this.items.has(envelope.messageId)) return;
    if (this.items.size >= MAX_ITEMS || this.retainedBytes + bytes > MAX_ROOM_BYTES)
      throw new Error('busy');
    this.items.set(envelope.messageId, { envelope, bytes });
    this.retainedBytes += bytes;
    this.extend(now);
  }

  revoke(id: string): void {
    const item = this.items.get(id);
    if (item) {
      this.retainedBytes -= item.bytes;
      this.items.delete(id);
    }
  }

  requestResult(id: string): unknown | undefined {
    return this.requests.get(id);
  }

  completeRequest(id: string, result: unknown): void {
    if (this.requests.has(id)) return;
    if (this.requests.size >= MAX_ROOM_COMMANDS) throw new Error('busy');
    this.requests.set(id, result);
  }

  ensureCommandCapacity(): void {
    if (this.requests.size >= MAX_ROOM_COMMANDS) throw new Error('busy');
  }

  snapshot(now: number): EncryptedEnvelope[] {
    this.tick(now);
    return [...this.items.values()].map((item) => item.envelope);
  }

  tick(now: number): void {
    if (this.ended) return;
    for (const [id, item] of this.items)
      if (item.envelope.expiresAt !== null && item.envelope.expiresAt <= now) this.revoke(id);
    if (
      this.activeState === 'PAIR_PENDING' &&
      this.pendingSince !== null &&
      now - this.pendingSince >= PENDING_MS
    )
      this.reject(now);
    if (!this.senderConnected && this.senderGraceUntil !== null && now >= this.senderGraceUntil) {
      this.end();
      return;
    }
    if (
      this.activeState === 'PAIRED' &&
      !this.receiverConnected &&
      this.receiverGraceUntil !== null &&
      now >= this.receiverGraceUntil
    ) {
      for (const id of this.items.keys()) this.revoke(id);
      this.receiverCredential = null;
      this.receiverGraceUntil = null;
      this.activeState = 'WAITING';
    }
    if (now >= this.deadline) this.end();
  }

  end(): void {
    this.ended = true;
    this.items.clear();
    this.requests.clear();
    this.retainedBytes = 0;
    this.receiverCredential = null;
    this.senderGraceUntil = null;
    this.receiverGraceUntil = null;
  }
}
