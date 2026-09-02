import { Buffer } from 'node:buffer';
import type { EncryptedEnvelope } from '../shared/envelope.js';
import {
  RECONNECT_GRACE_MS,
  type Role,
  type RoomSnapshot,
  type RoomState,
  type RoomStatus,
} from '../shared/protocol.js';

export const ROOM_TTL_MS = 600_000;
export const GRACE_MS = RECONNECT_GRACE_MS;
export const PENDING_MS = 60_000;

const MAX_ITEMS = 10;
const MAX_ROOM_BYTES = 256 * 1024;
const MAX_ROOM_COMMANDS = 4096;

type WaitingPhase = { kind: 'waiting' };
type PairingPhase = {
  kind: 'pairing';
  receiverCredential: string;
  pendingSince: number;
  pairFrames: number;
  request: EncryptedEnvelope | null;
};
type PairedPhase = {
  kind: 'paired';
  receiverCredential: string;
  approval: EncryptedEnvelope;
};
type EndedPhase = { kind: 'ended' };

type RoomPhase = WaitingPhase | PairingPhase | PairedPhase | EndedPhase;

interface RoleConnection {
  connected: boolean;
  graceUntil: number | null;
}

export interface StoredItem {
  envelope: EncryptedEnvelope;
  bytes: number;
}

export class Room {
  readonly items = new Map<string, StoredItem>();
  readonly #requests = new Map<string, unknown>();
  readonly #connections: Record<Role, RoleConnection> = {
    sender: { connected: true, graceUntil: null },
    receiver: { connected: false, graceUntil: null },
  };

  #phase: RoomPhase = { kind: 'waiting' };

  deadline: number;
  retainedBytes = 0;
  pairingBytes = 0;
  pendingAttempts = 0;

  constructor(
    readonly id: string,
    readonly addressGroup: string,
    readonly senderCredential: string,
    now: number,
  ) {
    this.deadline = now + ROOM_TTL_MS;
  }

  get totalRetainedBytes(): number {
    return this.retainedBytes + this.pairingBytes;
  }

  get ended(): boolean {
    return this.#phase.kind === 'ended';
  }

  get senderConnected(): boolean {
    return this.#connections.sender.connected;
  }

  get receiverConnected(): boolean {
    return this.#connections.receiver.connected;
  }

  get state(): RoomState | 'ENDED' {
    if (this.ended) {
      return 'ENDED';
    }

    if (!this.senderConnected) {
      return 'SENDER_GRACE';
    }

    if (this.#phase.kind !== 'waiting' && !this.receiverConnected) {
      return 'RECEIVER_GRACE';
    }

    if (this.#phase.kind === 'pairing') {
      return this.#phase.request ? 'PAIR_PENDING' : 'WAITING';
    }

    if (this.#phase.kind === 'paired') {
      return 'PAIRED';
    }

    return 'WAITING';
  }

  status(): RoomStatus {
    const state = this.state;
    if (state === 'ENDED') {
      throw new Error('expired');
    }

    return {
      state,
      deadline: this.deadline,
      senderConnected: this.senderConnected,
      receiverConnected: this.receiverConnected,
    };
  }

  snapshot(role: Role, now: number): RoomSnapshot {
    this.tick(now);
    const pairing =
      role === 'sender' && this.#phase.kind === 'pairing'
        ? this.#phase.request
        : role === 'receiver' && this.#phase.kind === 'paired'
          ? this.#phase.approval
          : null;

    return {
      ...this.status(),
      items: [...this.items.values()].map((item) => item.envelope),
      pairing,
    };
  }

  reserve(credential: string, now: number): void {
    this.tick(now);

    if (this.#phase.kind === 'pairing' && this.#phase.receiverCredential === credential) {
      this.connect('receiver', credential, now);
      return;
    }

    if (this.#phase.kind === 'paired' && this.#phase.receiverCredential === credential) {
      this.connect('receiver', credential, now);
      return;
    }

    if (this.#phase.kind !== 'waiting') {
      throw new Error('room_unavailable');
    }

    if (this.pendingAttempts >= 10) {
      throw new Error('rate_limited');
    }

    this.pendingAttempts += 1;
    this.#phase = {
      kind: 'pairing',
      receiverCredential: credential,
      pendingSince: now,
      pairFrames: 0,
      request: null,
    };
    this.#connections.receiver = { connected: true, graceUntil: null };
  }

  recordPairFrame(envelope: EncryptedEnvelope): void {
    if (this.#phase.kind !== 'pairing' || !this.receiverConnected) {
      throw new Error('not_allowed');
    }

    if (this.#phase.request?.messageId === envelope.messageId) {
      return;
    }

    if (this.#phase.pairFrames >= 1) {
      throw new Error('rate_limited');
    }

    this.#phase.pairFrames += 1;
    this.#phase.request = envelope;
    this.pairingBytes = Buffer.byteLength(JSON.stringify(envelope));
  }

  reject(now: number): void {
    if (this.#phase.kind !== 'pairing') {
      throw new Error('not_allowed');
    }

    this.#resetReceiver();
    this.tick(now);
  }

  approve(envelope: EncryptedEnvelope, now: number): void {
    this.tick(now);

    if (this.#phase.kind !== 'pairing' || !this.receiverConnected) {
      throw new Error('not_allowed');
    }

    this.#phase = {
      kind: 'paired',
      receiverCredential: this.#phase.receiverCredential,
      approval: envelope,
    };
    this.pairingBytes = Buffer.byteLength(JSON.stringify(envelope));
  }

  credentialFor(role: Role): string | null {
    if (role === 'sender') {
      return this.senderCredential;
    }

    if (this.#phase.kind === 'pairing' || this.#phase.kind === 'paired') {
      return this.#phase.receiverCredential;
    }

    return null;
  }

  connect(role: Role, credential: string, now: number): void {
    this.tick(now);

    if (this.ended || credential !== this.credentialFor(role)) {
      throw new Error('room_unavailable');
    }

    this.#connections[role] = { connected: true, graceUntil: null };
  }

  disconnect(role: Role, now: number): void {
    if (this.ended || !this.#connections[role].connected) {
      return;
    }

    this.#connections[role] = {
      connected: false,
      graceUntil: now + GRACE_MS,
    };
  }

  extend(now: number): void {
    this.tick(now);

    if (this.ended) {
      throw new Error('expired');
    }

    this.deadline = now + ROOM_TTL_MS;
  }

  store(envelope: EncryptedEnvelope, bytes: number, now: number): void {
    this.tick(now);

    if (this.state !== 'PAIRED') {
      throw new Error('not_allowed');
    }

    if (this.items.has(envelope.messageId)) {
      return;
    }

    if (this.items.size >= MAX_ITEMS || this.retainedBytes + bytes > MAX_ROOM_BYTES) {
      throw new Error('busy');
    }

    this.items.set(envelope.messageId, { envelope, bytes });
    this.retainedBytes += bytes;
    this.extend(now);
  }

  revoke(id: string): void {
    const item = this.items.get(id);
    if (!item) {
      return;
    }

    this.retainedBytes -= item.bytes;
    this.items.delete(id);
  }

  requestResult(role: Role, id: string): unknown | undefined {
    return this.#requests.get(this.#requestKey(role, id));
  }

  completeRequest(role: Role, id: string, result: unknown): void {
    const key = this.#requestKey(role, id);
    if (this.#requests.has(key)) {
      return;
    }

    if (this.#requests.size >= MAX_ROOM_COMMANDS) {
      throw new Error('busy');
    }

    this.#requests.set(key, result);
  }

  ensureCommandCapacity(): void {
    if (this.#requests.size >= MAX_ROOM_COMMANDS) {
      throw new Error('busy');
    }
  }

  tick(now: number): void {
    if (this.ended) {
      return;
    }

    for (const [id, item] of this.items) {
      if (item.envelope.expiresAt !== null && item.envelope.expiresAt <= now) {
        this.revoke(id);
      }
    }

    if (this.#phase.kind === 'pairing' && now - this.#phase.pendingSince >= PENDING_MS) {
      this.#resetReceiver();
    }

    const senderGrace = this.#connections.sender.graceUntil;
    if (!this.senderConnected && senderGrace !== null && now >= senderGrace) {
      this.end();
      return;
    }

    const receiverGrace = this.#connections.receiver.graceUntil;
    if (!this.receiverConnected && receiverGrace !== null && now >= receiverGrace) {
      this.#resetReceiver();
    }

    if (now >= this.deadline) {
      this.end();
    }
  }

  end(): void {
    this.#phase = { kind: 'ended' };
    this.items.clear();
    this.#requests.clear();
    this.retainedBytes = 0;
    this.pairingBytes = 0;
    this.#connections.sender = { connected: false, graceUntil: null };
    this.#connections.receiver = { connected: false, graceUntil: null };
  }

  #resetReceiver(): void {
    for (const id of this.items.keys()) {
      this.revoke(id);
    }

    this.#phase = { kind: 'waiting' };
    this.pairingBytes = 0;
    this.#connections.receiver = { connected: false, graceUntil: null };
  }

  #requestKey(role: Role, id: string): string {
    return `${role}:${id}`;
  }
}
