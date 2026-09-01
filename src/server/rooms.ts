import { randomBytes } from 'node:crypto';
import type { EncryptedEnvelope } from '../shared/envelope.js';

export type RoomState =
  'WAITING' | 'PAIR_PENDING' | 'PAIRED' | 'RECEIVER_GRACE' | 'SENDER_GRACE' | 'ENDED';
export const ROOM_TTL_MS = 600_000,
  GRACE_MS = 60_000,
  PENDING_MS = 60_000;
const MAX_ITEMS = 10,
  MAX_ROOM_BYTES = 256 * 1024;
const token = () => randomBytes(24).toString('base64url');
export interface StoredItem {
  envelope: EncryptedEnvelope;
  bytes: number;
}
export class Room {
  readonly id: string;
  readonly addressGroup: string;
  readonly senderCredential = token();
  state: RoomState = 'WAITING';
  deadline: number;
  priorState: RoomState = 'WAITING';
  receiverCredential: string | null = null;
  pendingSince: number | null = null;
  graceUntil: number | null = null;
  readonly items = new Map<string, StoredItem>();
  readonly requests = new Map<string, unknown>();
  retainedBytes = 0;
  pendingAttempts = 0;
  constructor(id: string, addressGroup: string, now: number) {
    this.id = id;
    this.addressGroup = addressGroup;
    this.deadline = now + ROOM_TTL_MS;
  }
  reserve(now: number): void {
    this.tick(now);
    if (this.state !== 'WAITING') throw new Error('room_unavailable');
    if (this.pendingAttempts >= 10) throw new Error('rate_limited');
    this.pendingAttempts++;
    this.state = 'PAIR_PENDING';
    this.pendingSince = now;
  }
  reject(now: number): void {
    if (this.state !== 'PAIR_PENDING') throw new Error('not_allowed');
    this.state = 'WAITING';
    this.pendingSince = null;
    this.receiverCredential = null;
    this.tick(now);
  }
  approve(now: number): string {
    if (this.state !== 'PAIR_PENDING') throw new Error('not_allowed');
    this.state = 'PAIRED';
    this.pendingSince = null;
    return (this.receiverCredential = token());
  }
  disconnect(role: 'sender' | 'receiver', now: number): void {
    if (this.state === 'ENDED') return;
    if (role === 'sender') {
      this.priorState = this.state;
      this.state = 'SENDER_GRACE';
      this.graceUntil = now + GRACE_MS;
    } else if (this.state === 'PAIR_PENDING') {
      this.reject(now);
    } else if (this.state === 'PAIRED') {
      this.state = 'RECEIVER_GRACE';
      this.graceUntil = now + GRACE_MS;
    }
  }
  resume(role: 'sender' | 'receiver', credential: string, now: number): void {
    this.tick(now);
    if (role === 'sender') {
      if (credential !== this.senderCredential || this.state !== 'SENDER_GRACE')
        throw new Error('room_unavailable');
      this.state = this.priorState === 'SENDER_GRACE' ? 'WAITING' : this.priorState;
      this.graceUntil = null;
      return;
    }
    if (credential !== this.receiverCredential || this.state !== 'RECEIVER_GRACE')
      throw new Error('room_unavailable');
    this.state = 'PAIRED';
    this.graceUntil = null;
  }
  extend(now: number): void {
    if (this.state === 'ENDED') throw new Error('expired');
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
  snapshot(now: number): EncryptedEnvelope[] {
    this.tick(now);
    return [...this.items.values()].map((i) => i.envelope);
  }
  tick(now: number): void {
    for (const [id, item] of this.items)
      if (item.envelope.expiresAt !== null && item.envelope.expiresAt <= now) this.revoke(id);
    if (
      this.state === 'PAIR_PENDING' &&
      this.pendingSince !== null &&
      now - this.pendingSince >= PENDING_MS
    )
      this.reject(now);
    if (this.state === 'SENDER_GRACE' && this.graceUntil !== null && now >= this.graceUntil)
      this.end();
    if (this.state === 'RECEIVER_GRACE' && this.graceUntil !== null && now >= this.graceUntil) {
      for (const id of this.items.keys()) this.revoke(id);
      this.receiverCredential = null;
      this.state = 'WAITING';
      this.graceUntil = null;
    }
    if (now >= this.deadline) this.end();
  }
  end(): void {
    this.state = 'ENDED';
    this.items.clear();
    this.retainedBytes = 0;
    this.receiverCredential = null;
    this.graceUntil = null;
  }
}
