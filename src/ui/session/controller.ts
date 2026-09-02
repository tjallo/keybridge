import {
  ITEM_TTLS,
  MAX_PLAINTEXT_BYTES,
  isEnvelope,
  matchesEnvelope,
  type EncryptedEnvelope,
} from '../../shared/envelope';
import {
  TRANSPORT_VERSION,
  type ClientFrame,
  type RoomSnapshot,
  type RoomStatus,
  type ServerFrame,
} from '../../shared/protocol';
import {
  ReplayGuard,
  base64url,
  decryptJson,
  derivePairingKey,
  deriveSessionKeys,
  encodePlaintext,
  encryptJson,
  fromBase64url,
  generatePin,
  normalizePin,
  randomBytes,
  randomId,
  type SessionKeys,
} from '../crypto';
import { initialSessionSnapshot, reduceConnection, type Item, type SessionSnapshot } from './model';
import {
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
  type StoredSession,
} from './storage';
import { RelayTransport, type TerminalReason, type TransportStatus } from './transport';

type Listener = (snapshot: SessionSnapshot) => void;

export class SessionController {
  #snapshot = initialSessionSnapshot();
  #listeners = new Set<Listener>();
  #transport: RelayTransport | null = null;
  #roomKey = '';
  #credential = '';
  #attached = false;
  #readyReceived = false;
  #pairingKey: CryptoKey | null = null;
  #keys: SessionKeys | null = null;
  #receiverNonce = '';
  #senderNonce = '';
  #itemReplay = new ReplayGuard();
  #pairingReplay = new ReplayGuard();
  #controlReplay = new ReplayGuard();
  readonly #expiryTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.#expiryTimer = setInterval(() => {
      const items = this.#snapshot.items.filter((item) => item.expiresAt > Date.now());
      if (items.length !== this.#snapshot.items.length) {
        this.#patch({ items });
      }
    }, 1_000);
  }

  get snapshot(): Readonly<SessionSnapshot> {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (await this.#importFragment()) {
      return;
    }

    const stored = loadStoredSession(sessionStorage);
    if (!stored) {
      return;
    }

    try {
      await this.#restore(stored);
    } catch {
      this.#endLocalSession('The saved room could not be restored.');
    }
  }

  destroy(): void {
    clearInterval(this.#expiryTimer);
    this.#transport?.close();
    this.#transport = null;
    this.#listeners.clear();
  }

  showSecurity(): void {
    if (this.#snapshot.view === 'start') {
      this.#patch({ view: 'security' });
    }
  }

  showStart(): void {
    if (this.#snapshot.view === 'security') {
      this.#patch({ view: 'start' });
    }
  }

  dismissError(): void {
    this.#patch({ error: '' });
  }

  async createRoom(): Promise<void> {
    this.#resetPrivateState();
    clearStoredSession(sessionStorage);

    const roomId = base64url(randomBytes(16));
    this.#roomKey = base64url(randomBytes(32));
    this.#credential = base64url(randomBytes(32));
    const pin = generatePin();
    this.#pairingKey = await derivePairingKey(fromBase64url(this.#roomKey), roomId, pin);

    this.#snapshot = {
      ...initialSessionSnapshot(),
      view: 'sender',
      role: 'sender',
      connection: 'connecting',
      roomId,
      link: `${location.origin}/#room=${roomId}&key=${this.#roomKey}`,
      pin,
    };
    this.#emit();
    this.#save();
    this.#connect('create');
  }

  async submitPin(value: string): Promise<void> {
    try {
      const pin = normalizePin(value);
      this.#pairingKey = await derivePairingKey(
        fromBase64url(this.#roomKey),
        this.#snapshot.roomId,
        pin,
      );
      this.#receiverNonce = randomId();
      this.#senderNonce = '';
      this.#keys = null;

      const envelope = await encryptJson(
        this.#pairingKey,
        {
          roomId: this.#snapshot.roomId,
          direction: 'receiver-to-sender',
          kind: 'pair-request',
          expiresAt: null,
        },
        { receiverNonce: this.#receiverNonce },
      );

      this.#patch({ pin, receiverView: 'PENDING', error: '' });
      this.#save();

      if (
        !(await this.#request({
          version: TRANSPORT_VERSION,
          type: 'pair',
          envelope,
          requestId: randomId(),
        }))
      ) {
        this.#patch({
          receiverView: 'PIN',
          error: 'The Relay did not accept the pairing request. Try again.',
        });
      }
    } catch {
      this.#patch({ error: 'The PIN format is invalid.' });
    }
  }

  async approve(): Promise<void> {
    if (!this.#pairingKey || !this.#receiverNonce) {
      return;
    }

    this.#senderNonce = randomId();
    this.#keys = await deriveSessionKeys(
      this.#pairingKey,
      this.#snapshot.roomId,
      this.#receiverNonce,
      this.#senderNonce,
    );
    const envelope = await encryptJson(
      this.#pairingKey,
      {
        roomId: this.#snapshot.roomId,
        direction: 'sender-to-receiver',
        kind: 'pair-response',
        expiresAt: null,
      },
      {
        approved: true,
        receiverNonce: this.#receiverNonce,
        senderNonce: this.#senderNonce,
      },
    );

    this.#patch({ canApprove: false, error: '' });
    this.#save();

    if (
      !(await this.#request({
        version: TRANSPORT_VERSION,
        type: 'approve',
        envelope,
        requestId: randomId(),
      }))
    ) {
      this.#patch({
        canApprove: true,
        error: 'The Relay did not accept the approval. Try again.',
      });
    }
  }

  async rejectPairing(): Promise<void> {
    const accepted = await this.#request({
      version: TRANSPORT_VERSION,
      type: 'reject',
      requestId: randomId(),
    });

    if (accepted) {
      await this.#rotatePin();
    } else {
      this.#patch({ error: 'The Relay did not accept the rejection. Try again.' });
    }
  }

  async sendItem(label: string, value: string, ttl: number): Promise<boolean> {
    if (!this.#keys || !isItemTtl(ttl)) {
      return false;
    }

    const createdAt = Date.now();
    const expiresAt = createdAt + ttl * 1_000;
    const id = randomId();
    const item: Item = { id, label, value, createdAt, expiresAt, ttl };
    const fields = {
      roomId: this.#snapshot.roomId,
      messageId: id,
      direction: 'sender-to-receiver' as const,
      kind: 'item' as const,
      expiresAt,
    };

    if (encodePlaintext(fields, item).length > MAX_PLAINTEXT_BYTES) {
      this.#patch({ error: 'The complete item plaintext exceeds 64 KiB.' });
      return false;
    }

    const envelope = await encryptJson(this.#keys.item, fields, item);
    const accepted = await this.#request({
      version: TRANSPORT_VERSION,
      type: 'item',
      envelope,
      requestId: randomId(),
    });
    if (!accepted) {
      this.#patch({ error: 'The Relay did not accept this item. Your input was preserved.' });
      return false;
    }

    this.#itemReplay.commit(id);
    this.#patch({ items: [...this.#snapshot.items, item] });
    return true;
  }

  async revoke(id: string): Promise<void> {
    if (!this.#keys || !this.#snapshot.role) {
      return;
    }

    const sender = this.#snapshot.role === 'sender';
    const envelope = await encryptJson(
      sender ? this.#keys.senderControl : this.#keys.receiverControl,
      {
        roomId: this.#snapshot.roomId,
        direction: sender ? 'sender-to-receiver' : 'receiver-to-sender',
        kind: 'control',
        expiresAt: null,
      },
      { itemId: id },
    );

    if (
      await this.#request({
        version: TRANSPORT_VERSION,
        type: 'revoke',
        itemId: id,
        envelope,
        requestId: randomId(),
      })
    ) {
      this.#patch({ items: this.#snapshot.items.filter((item) => item.id !== id) });
    } else {
      this.#patch({ error: 'The Relay did not acknowledge revocation.' });
    }
  }

  async extend(): Promise<void> {
    if (
      !(await this.#request({
        version: TRANSPORT_VERSION,
        type: 'extend',
        requestId: randomId(),
      }))
    ) {
      this.#patch({ error: 'The Relay did not extend the room.' });
    }
  }

  async end(): Promise<void> {
    await this.#request({
      version: TRANSPORT_VERSION,
      type: 'end',
      requestId: randomId(),
    });
    this.#endLocalSession();
  }

  leave(): void {
    this.#transport?.send({
      version: TRANSPORT_VERSION,
      type: 'leave',
      requestId: randomId(),
    });
    this.#endLocalSession();
  }

  async #importFragment(): Promise<boolean> {
    const params = new URLSearchParams(location.hash.slice(1));
    const roomId = params.get('room');
    const roomKey = params.get('key');
    if (!roomId || !roomKey) {
      return false;
    }

    history.replaceState(null, '', location.pathname + location.search);
    try {
      if (
        !/^[A-Za-z0-9_-]{22}$/.test(roomId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(roomKey) ||
        fromBase64url(roomKey).length !== 32
      ) {
        throw new Error('invalid pairing link');
      }
    } catch {
      this.#patch({ error: 'Invalid pairing link.' });
      return true;
    }

    this.#resetPrivateState();
    this.#roomKey = roomKey;
    this.#credential = base64url(randomBytes(32));
    this.#snapshot = {
      ...initialSessionSnapshot(),
      view: 'receiver',
      role: 'receiver',
      connection: 'connecting',
      roomId,
    };
    this.#emit();
    this.#save();
    this.#connect('join');
    return true;
  }

  async #restore(stored: StoredSession): Promise<void> {
    this.#resetPrivateState();
    this.#roomKey = stored.roomKey;
    this.#credential = stored.credential;
    this.#attached = stored.attached;
    this.#receiverNonce = stored.receiverNonce ?? '';
    this.#senderNonce = stored.senderNonce ?? '';

    if (stored.pin) {
      this.#pairingKey = await derivePairingKey(
        fromBase64url(stored.roomKey),
        stored.roomId,
        stored.pin,
      );
    }
    if (this.#pairingKey && this.#receiverNonce && this.#senderNonce) {
      this.#keys = await deriveSessionKeys(
        this.#pairingKey,
        stored.roomId,
        this.#receiverNonce,
        this.#senderNonce,
      );
    }

    this.#snapshot = {
      ...initialSessionSnapshot(),
      view: stored.role,
      role: stored.role,
      connection: 'connecting',
      roomId: stored.roomId,
      link:
        stored.role === 'sender'
          ? `${location.origin}/#room=${stored.roomId}&key=${stored.roomKey}`
          : '',
      pin: stored.pin,
      receiverView:
        stored.role === 'receiver'
          ? this.#keys
            ? 'PAIRED'
            : this.#receiverNonce
              ? 'PENDING'
              : 'PIN'
          : 'PIN',
      canApprove: stored.role === 'sender' && Boolean(this.#receiverNonce && !this.#senderNonce),
    };
    this.#emit();

    this.#connect(stored.attached ? 'resume' : stored.role === 'sender' ? 'create' : 'join');
  }

  #connect(mode: 'create' | 'join' | 'resume'): void {
    this.#transport?.close();
    const initial = this.#attachmentFrame(mode);
    this.#transport = new RelayTransport({
      url: webSocketUrl(),
      onStatus: (status) => this.#handleTransportStatus(status),
      onTerminal: (reason) => this.#handleTerminal(reason),
      onFrame: (frame) => this.#handleFrame(frame),
    });
    this.#transport.start(initial, () => this.#attachmentFrame('resume'));
  }

  #attachmentFrame(mode: 'create' | 'join' | 'resume'): ClientFrame {
    const requestId = randomId();
    if (mode === 'create') {
      return {
        version: TRANSPORT_VERSION,
        type: 'create',
        roomId: this.#snapshot.roomId,
        credential: this.#credential,
        requestId,
      };
    }
    if (mode === 'join') {
      return {
        version: TRANSPORT_VERSION,
        type: 'join',
        roomId: this.#snapshot.roomId,
        credential: this.#credential,
        requestId,
      };
    }

    if (!this.#snapshot.role) {
      throw new Error('Cannot resume without a role');
    }
    return {
      version: TRANSPORT_VERSION,
      type: 'resume',
      roomId: this.#snapshot.roomId,
      role: this.#snapshot.role,
      credential: this.#credential,
      requestId,
    };
  }

  #handleTransportStatus(status: TransportStatus): void {
    if (status === 'connected') {
      this.#snapshot = reduceConnection(this.#snapshot, { type: 'ready' });
    } else if (status === 'reconnecting') {
      this.#snapshot = reduceConnection(this.#snapshot, { type: 'lost' });
    } else {
      this.#snapshot = reduceConnection(this.#snapshot, { type: 'connect' });
    }
    this.#emit();
  }

  #handleTerminal(reason: TerminalReason): void {
    const message =
      reason === 'grace_expired'
        ? 'The reconnect period ended. Create or join a new room.'
        : reason === 'protocol_error'
          ? 'The Relay sent an invalid protocol message.'
          : 'The room connection closed.';
    this.#endLocalSession(message);
  }

  async #handleFrame(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case 'error':
        if (!this.#readyReceived || this.#snapshot.connection !== 'connected') {
          this.#endLocalSession(relayErrorMessage(frame.code));
        } else {
          this.#patch({ error: relayErrorMessage(frame.code) });
        }
        return;
      case 'ready':
        this.#attached = true;
        this.#readyReceived = true;
        await this.#applySnapshot(frame.snapshot);
        this.#save();
        return;
      case 'room_state':
        await this.#applyStatus(frame.status);
        return;
      case 'pair_request':
        await this.#handlePairRequest(frame.envelope);
        return;
      case 'approved':
        await this.#handleApproval(frame.envelope);
        return;
      case 'rejected':
        this.#restartReceiverAfterRejection();
        return;
      case 'item':
        await this.#receiveItem(frame.envelope);
        return;
      case 'revoked':
        await this.#receiveRevocation(frame.itemId, frame.envelope);
        return;
      case 'ack':
        if (frame.status) {
          await this.#applyStatus(frame.status);
        }
        return;
      case 'room_ended':
        this.#endLocalSession(roomEndMessage(frame.reason));
        return;
    }
  }

  async #applySnapshot(snapshot: RoomSnapshot): Promise<void> {
    await this.#applyStatus(snapshot);

    if (this.#snapshot.role === 'receiver' && !snapshot.pairing) {
      this.#patch({
        receiverView: this.#keys ? 'PAIRED' : this.#receiverNonce ? 'PENDING' : 'PIN',
      });
    }

    for (const envelope of snapshot.items) {
      await this.#receiveItem(envelope);
    }

    if (!snapshot.pairing) {
      return;
    }
    if (this.#snapshot.role === 'sender') {
      await this.#handlePairRequest(snapshot.pairing);
    } else {
      await this.#handleApproval(snapshot.pairing);
    }
  }

  async #applyStatus(status: RoomStatus): Promise<void> {
    const priorState = this.#snapshot.roomState;
    this.#patch({ roomState: status.state, deadline: status.deadline });

    if (
      this.#snapshot.role === 'sender' &&
      status.state === 'WAITING' &&
      (priorState === 'RECEIVER_GRACE' || this.#keys)
    ) {
      await this.#rotatePin();
    }
  }

  async #handlePairRequest(envelope: EncryptedEnvelope): Promise<void> {
    if (this.#snapshot.role !== 'sender' || !this.#pairingKey) {
      return;
    }

    this.#patch({ roomState: 'PAIR_PENDING' });

    try {
      if (
        !isEnvelope(envelope) ||
        this.#pairingReplay.has(envelope.messageId) ||
        !matchesEnvelope(envelope, {
          roomId: this.#snapshot.roomId,
          direction: 'receiver-to-sender',
          kind: 'pair-request',
          expiresAt: 'null',
        })
      ) {
        throw new Error('invalid pairing envelope');
      }

      const body = await decryptJson<{ receiverNonce: string }>(this.#pairingKey, envelope);
      if (!isNonce(body.receiverNonce)) {
        throw new Error('invalid receiver nonce');
      }

      this.#pairingReplay.commit(envelope.messageId);
      this.#receiverNonce = body.receiverNonce;
      this.#senderNonce = '';
      this.#keys = null;
      this.#patch({ canApprove: true, roomState: 'PAIR_PENDING', error: '' });
      this.#save();
    } catch {
      this.#patch({ error: 'Pairing authentication failed. Ask the Receiver to check the PIN.' });
    }
  }

  async #handleApproval(envelope: EncryptedEnvelope): Promise<void> {
    if (this.#snapshot.role !== 'receiver' || !this.#pairingKey) {
      return;
    }

    try {
      if (
        !isEnvelope(envelope) ||
        this.#pairingReplay.has(envelope.messageId) ||
        !matchesEnvelope(envelope, {
          roomId: this.#snapshot.roomId,
          direction: 'sender-to-receiver',
          kind: 'pair-response',
          expiresAt: 'null',
        })
      ) {
        throw new Error('invalid approval envelope');
      }

      const body = await decryptJson<{
        approved: boolean;
        receiverNonce: string;
        senderNonce: string;
      }>(this.#pairingKey, envelope);
      if (
        body.receiverNonce !== this.#receiverNonce ||
        !body.approved ||
        !isNonce(body.senderNonce)
      ) {
        throw new Error('invalid approval body');
      }

      this.#pairingReplay.commit(envelope.messageId);
      this.#senderNonce = body.senderNonce;
      this.#keys = await deriveSessionKeys(
        this.#pairingKey,
        this.#snapshot.roomId,
        this.#receiverNonce,
        this.#senderNonce,
      );
      this.#patch({ receiverView: 'PAIRED', roomState: 'PAIRED', error: '' });
      this.#save();
    } catch {
      this.#patch({ error: 'Approval authentication failed.' });
    }
  }

  async #receiveItem(envelope: EncryptedEnvelope): Promise<void> {
    if (
      !this.#keys ||
      !isEnvelope(envelope) ||
      this.#itemReplay.has(envelope.messageId) ||
      !matchesEnvelope(envelope, {
        roomId: this.#snapshot.roomId,
        direction: 'sender-to-receiver',
        kind: 'item',
        expiresAt: 'present',
      }) ||
      envelope.expiresAt === null ||
      envelope.expiresAt <= Date.now()
    ) {
      return;
    }

    try {
      const item = await decryptJson<Item & Record<string, unknown>>(this.#keys.item, envelope);
      if (!isValidItem(item, envelope)) {
        return;
      }

      this.#itemReplay.commit(envelope.messageId);
      this.#patch({
        items: [...this.#snapshot.items.filter((old) => old.id !== item.id), item],
      });
    } catch {
      this.#patch({ error: 'An encrypted item failed authentication.' });
    }
  }

  async #receiveRevocation(itemId: string, envelope: EncryptedEnvelope): Promise<void> {
    if (!this.#keys || !this.#snapshot.role) {
      return;
    }

    const sender = this.#snapshot.role === 'sender';
    const direction = sender ? 'receiver-to-sender' : 'sender-to-receiver';
    const key = sender ? this.#keys.receiverControl : this.#keys.senderControl;
    if (
      !isEnvelope(envelope) ||
      this.#controlReplay.has(envelope.messageId) ||
      !matchesEnvelope(envelope, {
        roomId: this.#snapshot.roomId,
        direction,
        kind: 'control',
        expiresAt: 'null',
      })
    ) {
      return;
    }

    try {
      const body = await decryptJson<{ itemId: string }>(key, envelope);
      if (body.itemId !== itemId) {
        throw new Error('control item mismatch');
      }

      this.#controlReplay.commit(envelope.messageId);
      this.#patch({ items: this.#snapshot.items.filter((item) => item.id !== body.itemId) });
    } catch {
      this.#patch({ error: 'A control message failed authentication.' });
    }
  }

  async #rotatePin(): Promise<void> {
    const pin = generatePin();
    this.#pairingKey = await derivePairingKey(
      fromBase64url(this.#roomKey),
      this.#snapshot.roomId,
      pin,
    );
    this.#receiverNonce = '';
    this.#senderNonce = '';
    this.#keys = null;
    this.#pairingReplay = new ReplayGuard();
    this.#controlReplay = new ReplayGuard();
    this.#patch({ pin, canApprove: false, items: [] });
    this.#save();
  }

  #restartReceiverAfterRejection(): void {
    this.#transport?.close();
    this.#transport = null;
    this.#credential = base64url(randomBytes(32));
    this.#attached = false;
    this.#readyReceived = false;
    this.#pairingKey = null;
    this.#keys = null;
    this.#receiverNonce = '';
    this.#senderNonce = '';
    this.#pairingReplay = new ReplayGuard();
    this.#controlReplay = new ReplayGuard();
    this.#patch({
      connection: 'connecting',
      receiverView: 'REJOINING',
      roomState: 'WAITING',
      pin: '',
      error: 'The Sender rejected this pairing request. Enter the new PIN to try again.',
    });
    this.#save();
    this.#connect('join');
  }

  #request(frame: ClientFrame): Promise<boolean> {
    if (!this.#transport || this.#snapshot.connection === 'terminal') {
      return Promise.resolve(false);
    }
    return this.#transport.request(frame);
  }

  #save(): void {
    if (!this.#snapshot.role || !this.#snapshot.roomId || !this.#roomKey || !this.#credential) {
      return;
    }

    saveStoredSession(sessionStorage, {
      version: TRANSPORT_VERSION,
      role: this.#snapshot.role,
      roomId: this.#snapshot.roomId,
      roomKey: this.#roomKey,
      pin: this.#snapshot.pin,
      credential: this.#credential,
      attached: this.#attached,
      ...(this.#receiverNonce ? { receiverNonce: this.#receiverNonce } : {}),
      ...(this.#senderNonce ? { senderNonce: this.#senderNonce } : {}),
    });
  }

  #endLocalSession(message = ''): void {
    this.#transport?.close();
    this.#transport = null;
    clearStoredSession(sessionStorage);
    this.#resetPrivateState();
    this.#snapshot = { ...initialSessionSnapshot(), error: message };
    this.#emit();
  }

  #resetPrivateState(): void {
    this.#transport?.close();
    this.#transport = null;
    this.#roomKey = '';
    this.#credential = '';
    this.#attached = false;
    this.#readyReceived = false;
    this.#pairingKey = null;
    this.#keys = null;
    this.#receiverNonce = '';
    this.#senderNonce = '';
    this.#itemReplay = new ReplayGuard();
    this.#pairingReplay = new ReplayGuard();
    this.#controlReplay = new ReplayGuard();
  }

  #patch(patch: Partial<SessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener(this.#snapshot);
    }
  }
}

function webSocketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/ws`;
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function isItemTtl(value: number): boolean {
  return ITEM_TTLS.includes(value as (typeof ITEM_TTLS)[number]);
}

function isValidItem(item: Item & Record<string, unknown>, envelope: EncryptedEnvelope): boolean {
  return (
    item.expiresAt === envelope.expiresAt &&
    item.id === envelope.messageId &&
    typeof item.id === 'string' &&
    typeof item.label === 'string' &&
    item.label.length <= 120 &&
    typeof item.value === 'string' &&
    typeof item.createdAt === 'number' &&
    Number.isSafeInteger(item.createdAt) &&
    typeof item.expiresAt === 'number' &&
    Number.isSafeInteger(item.expiresAt) &&
    typeof item.ttl === 'number' &&
    isItemTtl(item.ttl) &&
    item.expiresAt === item.createdAt + item.ttl * 1_000 &&
    new TextEncoder().encode(JSON.stringify(item)).length <= MAX_PLAINTEXT_BYTES
  );
}

function relayErrorMessage(code: unknown): string {
  switch (code) {
    case 'busy':
      return 'This room reached its capacity. End an active secret or try again later.';
    case 'expired':
      return 'This room expired.';
    case 'not_allowed':
      return 'This action is not available in the current room state.';
    case 'rate_limited':
      return 'Too many requests. Wait a moment and try again.';
    case 'room_unavailable':
      return 'This room is no longer available.';
    case 'unsupported_version':
      return 'This browser uses an unsupported transport protocol version.';
    default:
      return 'The Relay could not process the request.';
  }
}

function roomEndMessage(reason: unknown): string {
  if (reason === 'expired') {
    return 'The room expired.';
  }
  if (reason === 'busy') {
    return 'The room ended because it reached its capacity limit.';
  }
  if (reason === 'shutdown') {
    return 'The Relay restarted. Create a new room to continue.';
  }
  return 'The room ended.';
}
