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
  deriveSessionChains,
  encodePlaintext,
  encryptJson,
  exportEcdhPrivateKey,
  exportEcdhPublicKey,
  fromBase64url,
  generateEcdhKeyPair,
  generatePin,
  importEcdhPrivateKey,
  isEncodedEcdhPublicKey,
  normalizePin,
  randomBytes,
  randomId,
  type PairingTranscript,
} from '../crypto';
import {
  advanceSendRatchet,
  createSessionRatchets,
  prepareReceiveRatchet,
  pruneSessionRatchets,
  type SessionRatchets,
} from '../ratchet';
import { initialSessionSnapshot, reduceConnection, type Item, type SessionSnapshot } from './model';
import {
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
  type StoredSession,
} from './storage';
import { RelayTransport, type TerminalReason, type TransportStatus } from './transport';

type Listener = (snapshot: SessionSnapshot) => void;
type CryptoPhase = 'waiting' | 'pairing' | 'paired';

interface PairRequestBody {
  receiverNonce: string;
  receiverPublicKey: string;
}

interface ApprovalBody extends PairRequestBody {
  approved: boolean;
  senderNonce: string;
  senderPublicKey: string;
}

export class SessionController {
  #snapshot = initialSessionSnapshot();
  #listeners = new Set<Listener>();
  #transport: RelayTransport | null = null;
  #roomKey = '';
  #credential = '';
  #attached = false;
  #readyReceived = false;
  #phase: CryptoPhase = 'waiting';
  #pairingKey: CryptoKey | null = null;
  #receiverNonce = '';
  #receiverPublicKey = '';
  #receiverPrivateKey = '';
  #ratchets: SessionRatchets | null = null;
  #pending = new Map<string, ClientFrame>();
  #itemBusy = false;
  #controlBusy = false;
  #itemReplay = new ReplayGuard();
  #pairingReplay = new ReplayGuard();
  #controlReplay = new ReplayGuard();
  readonly #expiryTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.#expiryTimer = setInterval(() => {
      const now = Date.now();
      const items = this.#snapshot.items.filter((item) => item.expiresAt > now);
      if (items.length !== this.#snapshot.items.length) this.#patch({ items });
      if (this.#ratchets) {
        const ratchets = pruneSessionRatchets(this.#ratchets, now);
        if (ratchets !== this.#ratchets) {
          this.#ratchets = ratchets;
          if (!this.#save()) this.#endLocalSession('Browser session storage is unavailable.');
        }
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
    if (await this.#importFragment()) return;
    let stored: StoredSession | null;
    try {
      stored = loadStoredSession(sessionStorage);
    } catch {
      this.#patch({ error: 'Browser session storage is unavailable.' });
      return;
    }
    if (!stored) return;
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
    if (this.#snapshot.view === 'start') this.#patch({ view: 'security' });
  }

  showStart(): void {
    if (this.#snapshot.view === 'security') this.#patch({ view: 'start' });
  }

  dismissError(): void {
    this.#patch({ error: '' });
  }

  async createRoom(): Promise<void> {
    this.#resetPrivateState();
    if (!this.#clearStorage()) {
      this.#patch({ error: 'Browser session storage is unavailable.' });
      return;
    }
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
    if (!this.#save()) return this.#endLocalSession('Browser session storage is unavailable.');
    this.#connect('create');
  }

  async submitPin(value: string): Promise<void> {
    if (this.#snapshot.role !== 'receiver' || this.#phase === 'paired') return;
    try {
      const pin = normalizePin(value);
      this.#pairingKey = await derivePairingKey(
        fromBase64url(this.#roomKey),
        this.#snapshot.roomId,
        pin,
      );
      const keyPair = await generateEcdhKeyPair(true);
      this.#receiverNonce = randomId();
      this.#receiverPublicKey = await exportEcdhPublicKey(keyPair.publicKey);
      this.#receiverPrivateKey = await exportEcdhPrivateKey(keyPair.privateKey);
      this.#phase = 'pairing';

      const envelope = await encryptJson(
        this.#pairingKey,
        {
          roomId: this.#snapshot.roomId,
          direction: 'receiver-to-sender',
          kind: 'pair-request',
          expiresAt: null,
          generation: null,
        },
        { receiverNonce: this.#receiverNonce, receiverPublicKey: this.#receiverPublicKey },
      );
      const frame: ClientFrame = {
        version: TRANSPORT_VERSION,
        type: 'pair',
        envelope,
        requestId: randomId(),
      };
      this.#pending.set(frame.requestId, frame);
      this.#patch({ pin, receiverView: 'PENDING', error: '' });
      if (!this.#save()) return this.#endLocalSession('Browser session storage is unavailable.');

      const accepted = await this.#request(frame);
      this.#pending.delete(frame.requestId);
      if (!accepted) {
        this.#clearPairingAttempt();
        this.#phase = 'waiting';
        this.#patch({
          pin: '',
          receiverView: 'PIN',
          error: 'The Relay did not accept the pairing request. Try again.',
        });
      }
      this.#save();
    } catch {
      this.#patch({ error: 'The PIN format or pairing key is invalid.' });
    }
  }

  async approve(): Promise<void> {
    if (this.#snapshot.role !== 'sender') return;
    const existing = [...this.#pending.values()].find((frame) => frame.type === 'approve');
    if (existing) {
      const accepted = await this.#request(existing);
      if (accepted) this.#finishPendingApproval(existing.requestId);
      else
        this.#patch({
          canApprove: true,
          error: 'The Relay did not accept the approval. Try again.',
        });
      return;
    }
    if (!this.#pairingKey || !this.#receiverNonce || !this.#receiverPublicKey) return;

    try {
      const senderNonce = randomId();
      const senderKeys = await generateEcdhKeyPair(false);
      const senderPublicKey = await exportEcdhPublicKey(senderKeys.publicKey);
      const transcript: PairingTranscript = {
        roomId: this.#snapshot.roomId,
        receiverNonce: this.#receiverNonce,
        receiverPublicKey: this.#receiverPublicKey,
        senderNonce,
        senderPublicKey,
      };
      const seeds = await deriveSessionChains(
        senderKeys.privateKey,
        this.#receiverPublicKey,
        transcript,
      );
      const ratchets = createSessionRatchets(seeds);
      const envelope = await encryptJson(
        this.#pairingKey,
        {
          roomId: this.#snapshot.roomId,
          direction: 'sender-to-receiver',
          kind: 'pair-response',
          expiresAt: null,
          generation: null,
        },
        { approved: true, ...transcript },
      );
      const frame: ClientFrame = {
        version: TRANSPORT_VERSION,
        type: 'approve',
        envelope,
        requestId: randomId(),
      };

      this.#phase = 'paired';
      this.#ratchets = ratchets;
      this.#pending.set(frame.requestId, frame);
      this.#patch({ canApprove: false, error: '' });
      if (!this.#save()) return this.#endLocalSession('Browser session storage is unavailable.');

      if (await this.#request(frame)) this.#finishPendingApproval(frame.requestId);
      else
        this.#patch({
          canApprove: true,
          error: 'The Relay did not accept the approval. Try again.',
        });
    } catch {
      this.#patch({ canApprove: true, error: 'The Receiver supplied an invalid key agreement.' });
    }
  }

  async rejectPairing(): Promise<void> {
    const accepted = await this.#request({
      version: TRANSPORT_VERSION,
      type: 'reject',
      requestId: randomId(),
    });
    if (accepted) await this.#rotatePin();
    else this.#patch({ error: 'The Relay did not accept the rejection. Try again.' });
  }

  async sendItem(label: string, value: string, ttl: number): Promise<boolean> {
    if (!this.#ratchets || !isItemTtl(ttl) || this.#itemBusy) return false;
    this.#itemBusy = true;
    try {
      const transition = await advanceSendRatchet(
        this.#ratchets.senderItem,
        this.#snapshot.roomId,
        'sender-item',
      );
      if (!transition) return false;
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
        generation: transition.generation,
      };
      if (encodePlaintext(fields, item).length > MAX_PLAINTEXT_BYTES) {
        this.#patch({ error: 'The complete item plaintext exceeds 64 KiB.' });
        return false;
      }
      const envelope = await encryptJson(transition.key, fields, item);
      const frame: ClientFrame = {
        version: TRANSPORT_VERSION,
        type: 'item',
        envelope,
        requestId: randomId(),
      };
      this.#ratchets = { ...this.#ratchets, senderItem: transition.state };
      this.#pending.set(frame.requestId, frame);
      if (!this.#save()) {
        this.#endLocalSession('Browser session storage is unavailable.');
        return false;
      }

      const accepted = await this.#request(frame);
      this.#pending.delete(frame.requestId);
      this.#save();
      if (!accepted) {
        this.#patch({ error: 'The Relay did not accept this item. Your input was preserved.' });
        return false;
      }
      this.#itemReplay.commit(id);
      this.#patch({ items: [...this.#snapshot.items, item] });
      return true;
    } finally {
      this.#itemBusy = false;
    }
  }

  async revoke(id: string): Promise<void> {
    if (!this.#ratchets || !this.#snapshot.role || this.#controlBusy) return;
    this.#controlBusy = true;
    try {
      const sender = this.#snapshot.role === 'sender';
      const state = sender ? this.#ratchets.senderControl : this.#ratchets.receiverControl;
      const channel = sender ? 'sender-control' : 'receiver-control';
      const transition = await advanceSendRatchet(state, this.#snapshot.roomId, channel);
      if (!transition) return;
      const envelope = await encryptJson(
        transition.key,
        {
          roomId: this.#snapshot.roomId,
          direction: sender ? 'sender-to-receiver' : 'receiver-to-sender',
          kind: 'control',
          expiresAt: null,
          generation: transition.generation,
        },
        { itemId: id },
      );
      const frame: ClientFrame = {
        version: TRANSPORT_VERSION,
        type: 'revoke',
        itemId: id,
        envelope,
        requestId: randomId(),
      };
      this.#ratchets = sender
        ? { ...this.#ratchets, senderControl: transition.state }
        : { ...this.#ratchets, receiverControl: transition.state };
      this.#pending.set(frame.requestId, frame);
      if (!this.#save()) return this.#endLocalSession('Browser session storage is unavailable.');

      const accepted = await this.#request(frame);
      this.#pending.delete(frame.requestId);
      this.#save();
      if (accepted) this.#patch({ items: this.#snapshot.items.filter((item) => item.id !== id) });
      else this.#patch({ error: 'The Relay did not acknowledge revocation.' });
    } finally {
      this.#controlBusy = false;
    }
  }

  async extend(): Promise<void> {
    if (
      !(await this.#request({ version: TRANSPORT_VERSION, type: 'extend', requestId: randomId() }))
    ) {
      this.#patch({ error: 'The Relay did not extend the room.' });
    }
  }

  async end(): Promise<void> {
    await this.#request({ version: TRANSPORT_VERSION, type: 'end', requestId: randomId() });
    this.#endLocalSession();
  }

  leave(): void {
    this.#transport?.send({ version: TRANSPORT_VERSION, type: 'leave', requestId: randomId() });
    this.#endLocalSession();
  }

  async #importFragment(): Promise<boolean> {
    const params = new URLSearchParams(location.hash.slice(1));
    const roomId = params.get('room');
    const roomKey = params.get('key');
    if (!roomId || !roomKey) return false;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      if (
        !/^[A-Za-z0-9_-]{22}$/.test(roomId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(roomKey) ||
        fromBase64url(roomKey).length !== 32
      )
        throw new Error('invalid pairing link');
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
    if (!this.#save())
      return (this.#endLocalSession('Browser session storage is unavailable.'), true);
    this.#connect('join');
    return true;
  }

  async #restore(stored: StoredSession): Promise<void> {
    this.#resetPrivateState();
    this.#credential = stored.credential;
    this.#attached = stored.attached;
    this.#phase = stored.phase;
    this.#pending = new Map(stored.pending.map((frame) => [frame.requestId, frame]));
    if ('roomKey' in stored) this.#roomKey = stored.roomKey;
    if (stored.phase === 'pairing') {
      this.#receiverNonce = stored.receiverNonce;
      this.#receiverPublicKey = stored.receiverPublicKey;
      if (stored.role === 'receiver') this.#receiverPrivateKey = stored.receiverPrivateKey;
    }
    if (stored.phase === 'paired') this.#ratchets = stored.ratchets;
    if ('pin' in stored && stored.pin) {
      this.#pairingKey = await derivePairingKey(
        fromBase64url(stored.roomKey),
        stored.roomId,
        stored.pin,
      );
    }

    const omitted = stored.phase === 'paired' && stored.ratchets.senderItem.generation > 0;
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
      pin: 'pin' in stored ? stored.pin : '',
      receiverView:
        stored.role === 'receiver'
          ? stored.phase === 'paired'
            ? 'PAIRED'
            : stored.phase === 'pairing'
              ? 'PENDING'
              : 'PIN'
          : 'PIN',
      canApprove: stored.role === 'sender' && stored.phase === 'pairing',
      itemsOmittedAfterReload: omitted,
    };
    this.#emit();
    this.#connect(stored.attached ? 'resume' : stored.role === 'sender' ? 'create' : 'join');
  }

  #connect(mode: 'create' | 'join' | 'resume'): void {
    this.#transport?.close();
    this.#transport = new RelayTransport({
      url: webSocketUrl(),
      onStatus: (status) => this.#handleTransportStatus(status),
      onTerminal: (reason) => this.#handleTerminal(reason),
      onFrame: (frame) => this.#handleFrame(frame),
    });
    this.#transport.start(this.#attachmentFrame(mode), () => this.#attachmentFrame('resume'));
  }

  #attachmentFrame(mode: 'create' | 'join' | 'resume'): ClientFrame {
    const requestId = randomId();
    if (mode === 'create')
      return {
        version: TRANSPORT_VERSION,
        type: 'create',
        roomId: this.#snapshot.roomId,
        credential: this.#credential,
        requestId,
      };
    if (mode === 'join')
      return {
        version: TRANSPORT_VERSION,
        type: 'join',
        roomId: this.#snapshot.roomId,
        credential: this.#credential,
        requestId,
      };
    if (!this.#snapshot.role) throw new Error('Cannot resume without a role');
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
    this.#snapshot = reduceConnection(
      this.#snapshot,
      status === 'connected'
        ? { type: 'ready' }
        : status === 'reconnecting'
          ? { type: 'lost' }
          : { type: 'connect' },
    );
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
        if (!this.#readyReceived || this.#snapshot.connection !== 'connected')
          this.#endLocalSession(relayErrorMessage(frame.code));
        else this.#patch({ error: relayErrorMessage(frame.code) });
        return;
      case 'ready':
        this.#attached = true;
        this.#readyReceived = true;
        await this.#applySnapshot(frame.snapshot);
        this.#save();
        void this.#replayPending();
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
        if (frame.status) await this.#applyStatus(frame.status);
        return;
      case 'room_ended':
        this.#endLocalSession(roomEndMessage(frame.reason));
        return;
    }
  }

  async #applySnapshot(snapshot: RoomSnapshot): Promise<void> {
    await this.#applyStatus(snapshot);
    if (snapshot.pairing) {
      if (this.#snapshot.role === 'sender') {
        if (this.#phase !== 'paired') await this.#handlePairRequest(snapshot.pairing);
      } else if (this.#phase !== 'paired') {
        await this.#handleApproval(snapshot.pairing);
      }
    }
    if (this.#snapshot.role === 'receiver' && !snapshot.pairing) {
      this.#patch({
        receiverView:
          this.#phase === 'paired' ? 'PAIRED' : this.#phase === 'pairing' ? 'PENDING' : 'PIN',
      });
    }
    for (const envelope of snapshot.items) await this.#receiveItem(envelope);
  }

  async #applyStatus(status: RoomStatus): Promise<void> {
    const priorState = this.#snapshot.roomState;
    this.#patch({ roomState: status.state, deadline: status.deadline });
    if (
      this.#snapshot.role === 'sender' &&
      status.state === 'WAITING' &&
      (priorState === 'RECEIVER_GRACE' || this.#phase === 'paired')
    )
      await this.#rotatePin();
  }

  async #handlePairRequest(envelope: EncryptedEnvelope): Promise<void> {
    if (this.#snapshot.role !== 'sender' || !this.#pairingKey) return;
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
      )
        throw new Error('invalid pairing envelope');
      const body = await decryptJson<PairRequestBody>(this.#pairingKey, envelope);
      if (!isNonce(body.receiverNonce) || !isEncodedEcdhPublicKey(body.receiverPublicKey))
        throw new Error('invalid pairing body');
      this.#pairingReplay.commit(envelope.messageId);
      this.#phase = 'pairing';
      this.#receiverNonce = body.receiverNonce;
      this.#receiverPublicKey = body.receiverPublicKey;
      this.#ratchets = null;
      this.#patch({ canApprove: true, roomState: 'PAIR_PENDING', error: '' });
      this.#save();
    } catch {
      this.#patch({ error: 'Pairing authentication failed. Ask the Receiver to check the PIN.' });
    }
  }

  async #handleApproval(envelope: EncryptedEnvelope): Promise<void> {
    if (
      this.#snapshot.role !== 'receiver' ||
      !this.#pairingKey ||
      !this.#receiverPrivateKey ||
      this.#phase !== 'pairing'
    )
      return;
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
      )
        throw new Error('invalid approval envelope');
      const body = await decryptJson<ApprovalBody>(this.#pairingKey, envelope);
      if (
        !body.approved ||
        body.receiverNonce !== this.#receiverNonce ||
        body.receiverPublicKey !== this.#receiverPublicKey ||
        !isNonce(body.senderNonce) ||
        !isEncodedEcdhPublicKey(body.senderPublicKey)
      )
        throw new Error('invalid approval body');
      const privateKey = await importEcdhPrivateKey(this.#receiverPrivateKey);
      const seeds = await deriveSessionChains(privateKey, body.senderPublicKey, {
        roomId: this.#snapshot.roomId,
        receiverNonce: body.receiverNonce,
        receiverPublicKey: body.receiverPublicKey,
        senderNonce: body.senderNonce,
        senderPublicKey: body.senderPublicKey,
      });
      this.#ratchets = createSessionRatchets(seeds);
      this.#phase = 'paired';
      this.#pairingReplay.commit(envelope.messageId);
      this.#pending.clear();
      this.#roomKey = '';
      this.#pairingKey = null;
      this.#clearPairingAttempt();
      if (!this.#save()) return this.#endLocalSession('Browser session storage is unavailable.');
      this.#patch({ pin: '', receiverView: 'PAIRED', roomState: 'PAIRED', error: '' });
    } catch {
      this.#patch({ error: 'Approval authentication failed.' });
    }
  }

  async #receiveItem(envelope: EncryptedEnvelope): Promise<void> {
    if (
      this.#snapshot.role !== 'receiver' ||
      !this.#ratchets ||
      !isEnvelope(envelope) ||
      this.#itemReplay.has(envelope.messageId) ||
      !matchesEnvelope(envelope, {
        roomId: this.#snapshot.roomId,
        direction: 'sender-to-receiver',
        kind: 'item',
        expiresAt: 'present',
      }) ||
      envelope.generation === null ||
      envelope.expiresAt === null ||
      envelope.expiresAt <= Date.now()
    )
      return;

    const transition = await prepareReceiveRatchet(
      this.#ratchets.senderItem,
      envelope.generation,
      this.#snapshot.roomId,
      'sender-item',
      Date.now(),
    );
    if (!transition) return;
    try {
      const item = await decryptJson<Item & Record<string, unknown>>(transition.key, envelope);
      if (!isValidItem(item, envelope)) return;
      this.#ratchets = { ...this.#ratchets, senderItem: transition.state };
      if (!this.#save()) return this.#endLocalSession('Browser session storage is unavailable.');
      this.#itemReplay.commit(envelope.messageId);
      this.#patch({ items: [...this.#snapshot.items.filter((old) => old.id !== item.id), item] });
    } catch {
      this.#patch({ error: 'An encrypted item failed authentication.' });
    }
  }

  async #receiveRevocation(itemId: string, envelope: EncryptedEnvelope): Promise<void> {
    if (!this.#ratchets || !this.#snapshot.role || envelope.generation === null) return;
    const sender = this.#snapshot.role === 'sender';
    const direction = sender ? 'receiver-to-sender' : 'sender-to-receiver';
    const channel = sender ? 'receiver-control' : 'sender-control';
    const state = sender ? this.#ratchets.receiverControl : this.#ratchets.senderControl;
    if (
      !isEnvelope(envelope) ||
      this.#controlReplay.has(envelope.messageId) ||
      !matchesEnvelope(envelope, {
        roomId: this.#snapshot.roomId,
        direction,
        kind: 'control',
        expiresAt: 'null',
      })
    )
      return;
    const transition = await prepareReceiveRatchet(
      state,
      envelope.generation,
      this.#snapshot.roomId,
      channel,
      Date.now(),
    );
    if (!transition) return;
    try {
      const body = await decryptJson<{ itemId: string }>(transition.key, envelope);
      if (body.itemId !== itemId) throw new Error('control item mismatch');
      this.#ratchets = sender
        ? { ...this.#ratchets, receiverControl: transition.state }
        : { ...this.#ratchets, senderControl: transition.state };
      if (!this.#save()) return this.#endLocalSession('Browser session storage is unavailable.');
      this.#controlReplay.commit(envelope.messageId);
      this.#patch({ items: this.#snapshot.items.filter((item) => item.id !== itemId) });
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
    this.#phase = 'waiting';
    this.#ratchets = null;
    this.#pending.clear();
    this.#clearPairingAttempt();
    this.#pairingReplay = new ReplayGuard();
    this.#controlReplay = new ReplayGuard();
    this.#patch({ pin, canApprove: false, items: [], itemsOmittedAfterReload: false });
    this.#save();
  }

  #restartReceiverAfterRejection(): void {
    this.#transport?.close();
    this.#transport = null;
    this.#credential = base64url(randomBytes(32));
    this.#attached = false;
    this.#readyReceived = false;
    this.#phase = 'waiting';
    this.#pairingKey = null;
    this.#ratchets = null;
    this.#pending.clear();
    this.#clearPairingAttempt();
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

  async #replayPending(): Promise<void> {
    for (const frame of [...this.#pending.values()]) {
      const accepted = await this.#request(frame);
      if (accepted && frame.type === 'approve') {
        this.#finishPendingApproval(frame.requestId);
        continue;
      }
      if (!accepted && frame.type === 'approve') {
        this.#patch({
          canApprove: true,
          error: 'The Relay did not accept the approval. Try again.',
        });
        continue;
      }
      this.#pending.delete(frame.requestId);
      if (!accepted && frame.type === 'pair') {
        this.#clearPairingAttempt();
        this.#phase = 'waiting';
        this.#patch({
          pin: '',
          receiverView: 'PIN',
          error: 'The Relay did not accept the pairing request. Try again.',
        });
      }
      this.#save();
    }
  }

  #finishPendingApproval(requestId: string): void {
    this.#pending.delete(requestId);
    this.#pairingKey = null;
    this.#clearPairingAttempt();
    this.#patch({ canApprove: false });
    this.#save();
  }

  #request(frame: ClientFrame): Promise<boolean> {
    if (!this.#transport || this.#snapshot.connection === 'terminal') return Promise.resolve(false);
    return this.#transport.request(frame);
  }

  #save(): boolean {
    if (!this.#snapshot.role || !this.#snapshot.roomId || !this.#credential) return false;
    const common = {
      version: TRANSPORT_VERSION,
      roomId: this.#snapshot.roomId,
      credential: this.#credential,
      attached: this.#attached,
      pending: [...this.#pending.values()],
    };
    let stored: StoredSession;
    if (this.#snapshot.role === 'sender') {
      if (!this.#roomKey || !this.#snapshot.pin) return false;
      stored =
        this.#phase === 'paired' && this.#ratchets
          ? {
              ...common,
              role: 'sender',
              phase: 'paired',
              roomKey: this.#roomKey,
              pin: this.#snapshot.pin,
              ratchets: this.#ratchets,
            }
          : this.#phase === 'pairing' && this.#receiverNonce && this.#receiverPublicKey
            ? {
                ...common,
                role: 'sender',
                phase: 'pairing',
                roomKey: this.#roomKey,
                pin: this.#snapshot.pin,
                receiverNonce: this.#receiverNonce,
                receiverPublicKey: this.#receiverPublicKey,
              }
            : {
                ...common,
                role: 'sender',
                phase: 'waiting',
                roomKey: this.#roomKey,
                pin: this.#snapshot.pin,
              };
    } else {
      stored =
        this.#phase === 'paired' && this.#ratchets
          ? { ...common, role: 'receiver', phase: 'paired', ratchets: this.#ratchets }
          : this.#phase === 'pairing' &&
              this.#roomKey &&
              this.#snapshot.pin &&
              this.#receiverNonce &&
              this.#receiverPublicKey &&
              this.#receiverPrivateKey
            ? {
                ...common,
                role: 'receiver',
                phase: 'pairing',
                roomKey: this.#roomKey,
                pin: this.#snapshot.pin,
                receiverNonce: this.#receiverNonce,
                receiverPublicKey: this.#receiverPublicKey,
                receiverPrivateKey: this.#receiverPrivateKey,
              }
            : { ...common, role: 'receiver', phase: 'waiting', roomKey: this.#roomKey, pin: '' };
    }
    try {
      saveStoredSession(sessionStorage, stored);
      return true;
    } catch {
      return false;
    }
  }

  #endLocalSession(message = ''): void {
    this.#transport?.close();
    this.#transport = null;
    this.#clearStorage();
    this.#resetPrivateState();
    this.#snapshot = { ...initialSessionSnapshot(), error: message };
    this.#emit();
  }

  #clearStorage(): boolean {
    try {
      clearStoredSession(sessionStorage);
      return true;
    } catch {
      return false;
    }
  }

  #clearPairingAttempt(): void {
    this.#receiverNonce = '';
    this.#receiverPublicKey = '';
    this.#receiverPrivateKey = '';
  }

  #resetPrivateState(): void {
    this.#transport?.close();
    this.#transport = null;
    this.#roomKey = '';
    this.#credential = '';
    this.#attached = false;
    this.#readyReceived = false;
    this.#phase = 'waiting';
    this.#pairingKey = null;
    this.#ratchets = null;
    this.#pending.clear();
    this.#clearPairingAttempt();
    this.#itemReplay = new ReplayGuard();
    this.#pairingReplay = new ReplayGuard();
    this.#controlReplay = new ReplayGuard();
  }

  #patch(patch: Partial<SessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#snapshot);
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
  if (reason === 'expired') return 'The room expired.';
  if (reason === 'busy') return 'The room ended because it reached its capacity limit.';
  if (reason === 'shutdown') return 'The Relay restarted. Create a new room to continue.';
  return 'The room ended.';
}
