import {
  HEARTBEAT_ALLOWANCE_MS,
  RECONNECT_GRACE_MS,
  decodeServerFrame,
  type ClientFrame,
  type ServerFrame,
} from '../../shared/protocol.js';

const SOCKET_OPEN = 1;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;

export type TransportStatus = 'connecting' | 'connected' | 'reconnecting';
export type TerminalReason = 'grace_expired' | 'protocol_error' | 'closed';

export interface SocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface TransportTimer {
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}

export interface RelayTransportOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  random?: () => number;
  timer?: TransportTimer;
  onFrame: (frame: ServerFrame) => void | Promise<void>;
  onStatus: (status: TransportStatus) => void;
  onTerminal: (reason: TerminalReason) => void;
}

interface PendingRequest {
  frame: ClientFrame;
  resolve: (accepted: boolean) => void;
}

export class RelayTransport {
  readonly #url: string;
  readonly #createSocket: (url: string) => SocketLike;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #timerApi: TransportTimer;
  readonly #onFrame: RelayTransportOptions['onFrame'];
  readonly #onStatus: RelayTransportOptions['onStatus'];
  readonly #onTerminal: RelayTransportOptions['onTerminal'];
  readonly #pending = new Map<string, PendingRequest>();

  #initialFrame: ClientFrame | null = null;
  #resumeFrame: (() => ClientFrame) | null = null;
  #socket: SocketLike | null = null;
  #timer: unknown = null;
  #generation = 0;
  #attempt = 0;
  #reconnectDeadline: number | null = null;
  #attached = false;
  #stopped = false;
  #messageChain: Promise<void> = Promise.resolve();

  readonly #onlineListener = () => this.wake();
  readonly #offlineListener = () => {
    this.#socket?.close(4003, 'offline');
  };
  readonly #visibilityListener = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      this.wake();
    }
  };

  constructor(options: RelayTransportOptions) {
    this.#url = options.url;
    this.#createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#timerApi =
      options.timer ??
      ({
        set: (callback, delay) => setTimeout(callback, delay),
        clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      } satisfies TransportTimer);
    this.#onFrame = options.onFrame;
    this.#onStatus = options.onStatus;
    this.#onTerminal = options.onTerminal;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.#onlineListener);
      window.addEventListener('offline', this.#offlineListener);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#visibilityListener);
    }
  }

  start(initialFrame: ClientFrame, resumeFrame: () => ClientFrame): void {
    this.#initialFrame = initialFrame;
    this.#resumeFrame = resumeFrame;
    this.#stopped = false;
    this.#open();
  }

  request(frame: ClientFrame): Promise<boolean> {
    if (!('requestId' in frame)) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      this.#pending.set(frame.requestId, { frame, resolve });
      this.#sendIfReady(frame);
    });
  }

  send(frame: ClientFrame): boolean {
    if (!this.#attached || this.#socket?.readyState !== SOCKET_OPEN) {
      return false;
    }

    this.#socket.send(JSON.stringify(frame));
    return true;
  }

  wake(): void {
    if (this.#stopped || this.#socket) {
      return;
    }

    if (this.#timer !== null) {
      this.#timerApi.clear(this.#timer);
      this.#timer = null;
    }

    this.#open();
  }

  close(): void {
    if (this.#stopped) {
      return;
    }

    this.#stopped = true;
    this.#generation += 1;
    this.#clearTimer();

    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, 'client_closed');

    this.#finishPending(false);
    this.#removeLifecycleListeners();
  }

  #open(): void {
    if (this.#stopped || this.#socket || !this.#initialFrame || !this.#resumeFrame) {
      return;
    }

    if (this.#deadlineReached()) {
      this.#terminate('grace_expired');
      return;
    }

    this.#onStatus(this.#attached ? 'reconnecting' : 'connecting');
    const generation = ++this.#generation;
    let socket: SocketLike;

    try {
      socket = this.#createSocket(this.#url);
    } catch {
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    socket.onopen = () => {
      if (!this.#isCurrent(generation, socket)) {
        return;
      }

      const handshake = this.#attached ? this.#resumeFrame?.() : this.#initialFrame;
      if (handshake) {
        socket.send(JSON.stringify(handshake));
      }
    };
    socket.onmessage = (event) => {
      if (!this.#isCurrent(generation, socket)) {
        return;
      }

      this.#messageChain = this.#messageChain
        .then(() => this.#processMessage(String(event.data)))
        .catch(() => this.#terminate('protocol_error'));
    };
    socket.onerror = () => {
      // The close event starts reconnect. Browser WebSocket errors contain no safe detail.
    };
    socket.onclose = (event) => {
      if (!this.#isCurrent(generation, socket)) {
        return;
      }

      this.#socket = null;
      if (this.#stopped) {
        return;
      }

      if (event.code === 4001 || event.code === 1000) {
        this.#terminate('closed');
        return;
      }

      if (this.#reconnectDeadline === null) {
        this.#reconnectDeadline = this.#now() + RECONNECT_GRACE_MS + HEARTBEAT_ALLOWANCE_MS;
      }
      this.#scheduleReconnect();
    };
  }

  async #processMessage(text: string): Promise<void> {
    const decoded = decodeServerFrame(text);
    if (!decoded.ok) {
      this.#terminate('protocol_error');
      return;
    }

    const frame = decoded.value;
    if (frame.type === 'ready') {
      this.#attached = true;
      this.#attempt = 0;
      this.#reconnectDeadline = null;
      await this.#onFrame(frame);
      this.#onStatus('connected');
      this.#flushPending();
      return;
    }

    if (frame.type === 'ack') {
      this.#resolvePending(frame.requestId, true);
    } else if (frame.type === 'error' && frame.requestId) {
      this.#resolvePending(frame.requestId, false);
    }

    await this.#onFrame(frame);
  }

  #sendIfReady(frame: ClientFrame): void {
    if (this.#attached && this.#socket?.readyState === SOCKET_OPEN) {
      this.#socket.send(JSON.stringify(frame));
    }
  }

  #flushPending(): void {
    for (const pending of this.#pending.values()) {
      this.#sendIfReady(pending.frame);
    }
  }

  #resolvePending(requestId: string, accepted: boolean): void {
    const pending = this.#pending.get(requestId);
    if (!pending) {
      return;
    }

    this.#pending.delete(requestId);
    pending.resolve(accepted);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#socket || this.#timer !== null) {
      return;
    }

    if (this.#deadlineReached()) {
      this.#terminate('grace_expired');
      return;
    }

    this.#onStatus('reconnecting');
    const base = Math.min(INITIAL_BACKOFF_MS * 2 ** this.#attempt, MAX_BACKOFF_MS);
    this.#attempt += 1;
    const jittered = Math.round(base * (0.5 + this.#random()));
    const remaining =
      this.#reconnectDeadline === null
        ? jittered
        : Math.max(0, this.#reconnectDeadline - this.#now());
    const delay = Math.min(jittered, remaining);

    this.#timer = this.#timerApi.set(() => {
      this.#timer = null;
      this.#open();
    }, delay);
  }

  #deadlineReached(): boolean {
    return this.#reconnectDeadline !== null && this.#now() >= this.#reconnectDeadline;
  }

  #terminate(reason: TerminalReason): void {
    if (this.#stopped) {
      return;
    }

    this.#stopped = true;
    this.#generation += 1;
    this.#clearTimer();

    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, 'terminal');

    this.#finishPending(false);
    this.#removeLifecycleListeners();
    this.#onTerminal(reason);
  }

  #finishPending(accepted: boolean): void {
    for (const pending of this.#pending.values()) {
      pending.resolve(accepted);
    }
    this.#pending.clear();
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      this.#timerApi.clear(this.#timer);
      this.#timer = null;
    }
  }

  #removeLifecycleListeners(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.#onlineListener);
      window.removeEventListener('offline', this.#offlineListener);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#visibilityListener);
    }
  }

  #isCurrent(generation: number, socket: SocketLike): boolean {
    return generation === this.#generation && socket === this.#socket;
  }
}
