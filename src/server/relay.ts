import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES } from '../shared/envelope.js';
import {
  HEARTBEAT_INTERVAL_MS,
  PUBLIC_ERROR_CODES,
  TRANSPORT_VERSION,
  decodeClientFrame,
  type ClientFrame,
  type PublicErrorCode,
  type Role,
} from '../shared/protocol.js';
import { PeerRegistry, type Peer } from './peer-registry.js';
import { RateLimiter, addressGroup } from './rate-limit.js';
import { dispatchRoomCommand, type RelayEffect, type ServerPayload } from './relay-commands.js';
import { Room } from './rooms.js';
import { sourceAddress, type ProxyTrustConfig } from './security.js';

export class Relay {
  readonly rooms = new Map<string, Room>();
  readonly limiter = new RateLimiter();

  readonly #clock: () => number;
  readonly #origin: string;
  readonly #proxy: ProxyTrustConfig;
  readonly #peers = new PeerRegistry();
  readonly #timer: NodeJS.Timeout;
  readonly #wss: WebSocketServer;

  constructor(
    server: import('node:http').Server,
    origin: string,
    clock: () => number = Date.now,
    proxy: ProxyTrustConfig = { enabled: false, trustedAddresses: new Set() },
  ) {
    this.#origin = origin;
    this.#clock = clock;
    this.#proxy = proxy;
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });

    server.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head));
    this.#wss.on('connection', (socket, request) => this.#connection(socket, request));

    this.#timer = setInterval(() => this.#maintenance(), HEARTBEAT_INTERVAL_MS);
    this.#timer.unref();
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;

    try {
      url = new URL(request.url ?? '/', 'http://internal');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }

    if (url.pathname !== '/ws' || request.headers.origin !== this.#origin) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const group = addressGroup(sourceAddress(request, this.#proxy));
    if (!this.limiter.canConnect(group)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    this.#wss.handleUpgrade(request, socket, head, (webSocket) => {
      this.#wss.emit('connection', webSocket, request);
    });
  }

  #connection(socket: WebSocket, request: IncomingMessage): void {
    const group = addressGroup(sourceAddress(request, this.#proxy));
    this.limiter.connect(group);

    const peer: Peer = {
      socket,
      group,
      room: null,
      role: null,
      alive: true,
      commandTimes: [],
      intentional: false,
      roleTimer: null,
    };

    socket.on('pong', () => {
      peer.alive = true;
    });
    socket.on('message', (data, binary) => {
      if (binary) {
        this.#fail(peer, 'invalid_message');
        return;
      }

      this.#message(peer, data.toString());
    });
    socket.on('error', () => {
      // The close handler owns peer cleanup. WebSocket errors are intentionally not logged.
    });
    socket.on('close', () => this.#closed(peer));

    peer.roleTimer = setTimeout(() => {
      if (!peer.role && socket.readyState === WebSocket.OPEN) {
        this.#fail(peer, 'invalid_message');
      }
    }, 10_000);
    peer.roleTimer.unref();
  }

  #message(peer: Peer, text: string): void {
    const decoded = decodeClientFrame(text);
    if (!decoded.ok) {
      this.#fail(peer, decoded.code);
      return;
    }

    const message = decoded.value;
    const now = this.#clock();
    peer.commandTimes = peer.commandTimes.filter((time) => now - time < 60_000);

    if (peer.commandTimes.length >= 200) {
      this.#error(peer, new Error('rate_limited'), message.requestId);
      return;
    }

    peer.commandTimes.push(now);

    try {
      if (!peer.role) {
        this.#attachCommand(peer, message, now);
        return;
      }

      if (message.type === 'create' || message.type === 'join' || message.type === 'resume') {
        throw new Error('not_allowed');
      }

      if (!peer.room || !this.#peers.isCurrent(peer)) {
        throw new Error('room_unavailable');
      }

      const effects = dispatchRoomCommand(peer.room, peer.role, message, now);
      this.#applyEffects(peer, effects);
    } catch (error) {
      this.#error(peer, error, message.requestId);
    }
  }

  #attachCommand(peer: Peer, message: ClientFrame, now: number): void {
    switch (message.type) {
      case 'create':
        this.#create(peer, message.roomId, message.credential, message.requestId, now);
        return;
      case 'join':
        this.#join(peer, message.roomId, message.credential, message.requestId, now);
        return;
      case 'resume':
        this.#resume(
          peer,
          message.roomId,
          message.role,
          message.credential,
          message.requestId,
          now,
        );
        return;
      default:
        throw new Error('not_allowed');
    }
  }

  #create(peer: Peer, roomId: string, credential: string, requestId: string, now: number): void {
    const existing = this.rooms.get(roomId);
    if (existing) {
      existing.connect('sender', credential, now);
      this.#attach(peer, existing, 'sender');
      this.#ready(peer, requestId, 'resumed', now);
      return;
    }

    if (this.rooms.size >= 500) {
      throw new Error('busy');
    }

    const liveRooms = [...this.rooms.values()].filter(
      (room) => room.addressGroup === peer.group && !room.ended,
    ).length;
    if (this.limiter.canCreate(peer.group, liveRooms, now) !== 'ok') {
      throw new Error('rate_limited');
    }

    const room = new Room(roomId, peer.group, credential, now);
    this.rooms.set(roomId, room);
    this.limiter.created(peer.group, now);
    this.#attach(peer, room, 'sender');
    this.#ready(peer, requestId, 'created', now);
  }

  #join(peer: Peer, roomId: string, credential: string, requestId: string, now: number): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error('room_unavailable');
    }

    const isExistingReceiver = room.credentialFor('receiver') === credential;
    if (!isExistingReceiver && !this.limiter.canAttemptPairing(peer.group, now)) {
      throw new Error('rate_limited');
    }

    room.reserve(credential, now);
    this.#attach(peer, room, 'receiver');
    this.#ready(peer, requestId, isExistingReceiver ? 'resumed' : 'joined', now);
    this.#notify(room, { type: 'room_state', status: room.status() }, 'receiver');
  }

  #resume(
    peer: Peer,
    roomId: string,
    role: Role,
    credential: string,
    requestId: string,
    now: number,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error('room_unavailable');
    }

    room.connect(role, credential, now);
    this.#attach(peer, room, role);
    this.#ready(peer, requestId, 'resumed', now);
    this.#notify(room, { type: 'room_state', status: room.status() }, role);
  }

  #attach(peer: Peer, room: Room, role: Role): void {
    if (peer.roleTimer) {
      clearTimeout(peer.roleTimer);
      peer.roleTimer = null;
    }

    const replaced = this.#peers.attach(peer, room, role);
    if (!replaced || replaced === peer) {
      return;
    }

    replaced.intentional = true;
    if (replaced.roleTimer) {
      clearTimeout(replaced.roleTimer);
      replaced.roleTimer = null;
    }
    replaced.socket.close(4002, 'replaced');
  }

  #ready(peer: Peer, requestId: string, mode: 'created' | 'joined' | 'resumed', now: number): void {
    if (!peer.room || !peer.role) {
      throw new Error('room_unavailable');
    }

    this.#send(peer, {
      type: 'ready',
      requestId,
      mode,
      snapshot: peer.room.snapshot(peer.role, now),
    });
  }

  #applyEffects(peer: Peer, effects: RelayEffect[]): void {
    for (const effect of effects) {
      const room = peer.room;
      if (!room) {
        return;
      }

      switch (effect.type) {
        case 'reply':
          this.#send(peer, effect.message);
          break;
        case 'send':
          this.#sendRole(room, effect.role, effect.message);
          break;
        case 'notify':
          this.#notify(room, effect.message, effect.except);
          break;
        case 'close_self':
          peer.intentional = true;
          this.#peers.removeIfCurrent(peer);
          peer.socket.close(effect.code, effect.reason);
          break;
        case 'end':
          this.#end(room, effect.reason);
          return;
      }
    }
  }

  #closed(peer: Peer): void {
    this.limiter.disconnect(peer.group);

    if (peer.roleTimer) {
      clearTimeout(peer.roleTimer);
      peer.roleTimer = null;
    }

    if (peer.intentional || !peer.room || !peer.role) {
      return;
    }

    if (!this.#peers.removeIfCurrent(peer)) {
      return;
    }

    peer.room.disconnect(peer.role, this.#clock());
    if (!peer.room.ended) {
      this.#notify(peer.room, { type: 'room_state', status: peer.room.status() });
    }
  }

  #maintenance(): void {
    const now = this.#clock();
    let retainedBytes = 0;

    for (const room of [...this.rooms.values()]) {
      const priorState = room.state;
      room.tick(now);
      retainedBytes += room.totalRetainedBytes;

      if (room.ended) {
        this.#end(room, 'expired');
      } else if (room.state !== priorState) {
        this.#notify(room, { type: 'room_state', status: room.status() });
      }
    }

    if (retainedBytes > 128 * 1024 * 1024) {
      for (const room of [...this.rooms.values()]) {
        this.#end(room, 'busy');
      }
    }

    for (const peer of this.#peers.all()) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }

      peer.alive = false;
      peer.socket.ping();
    }

    this.limiter.cleanup(now);
  }

  #end(room: Room, reason: string): void {
    room.end();
    this.#notify(room, { type: 'room_ended', reason });

    for (const peer of this.#peers.peersFor(room.id)) {
      peer.intentional = true;
      peer.socket.close(4001, reason);
    }

    this.#peers.deleteRoom(room.id);
    this.rooms.delete(room.id);
  }

  #notify(room: Room, message: ServerPayload, except?: Role): void {
    for (const role of ['sender', 'receiver'] as const) {
      if (role !== except) {
        this.#sendRole(room, role, message);
      }
    }
  }

  #sendRole(room: Room, role: Role, message: ServerPayload): void {
    const peer = this.#peers.current(room.id, role);
    if (peer) {
      this.#send(peer, message);
    }
  }

  #send(peer: Peer, message: ServerPayload): void {
    if (peer.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    peer.socket.send(JSON.stringify({ version: TRANSPORT_VERSION, ...message }));
  }

  #error(peer: Peer, error: unknown, requestId?: string): void {
    const message = error instanceof Error ? error.message : '';
    const code = PUBLIC_ERROR_CODES.includes(message as PublicErrorCode)
      ? (message as PublicErrorCode)
      : 'invalid_message';

    this.#send(peer, {
      type: 'error',
      code,
      ...(requestId ? { requestId } : {}),
    });

    if (code === 'invalid_message') {
      peer.socket.close(1007, code);
    }
  }

  #fail(peer: Peer, code: 'invalid_message' | 'unsupported_version'): void {
    this.#send(peer, { type: 'error', code });
    peer.socket.close(1008, code);
  }

  shutdown(): void {
    clearInterval(this.#timer);

    for (const room of [...this.rooms.values()]) {
      this.#end(room, 'shutdown');
    }

    for (const socket of this.#wss.clients) {
      socket.close(1001, 'shutdown');
    }

    this.#wss.close();
  }
}
