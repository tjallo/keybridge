import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEARTBEAT_ALLOWANCE_MS,
  RECONNECT_GRACE_MS,
  TRANSPORT_VERSION,
  type ClientFrame,
} from '../build/shared/protocol.js';
import {
  RelayTransport,
  type SocketLike,
  type TransportTimer,
} from '../build/ui/session/transport.js';

const roomId = 'A'.repeat(22);
const credential = 'C'.repeat(43);
const requestId = 'R'.repeat(22);

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(frame: object): void {
    this.onmessage?.({ data: JSON.stringify({ version: TRANSPORT_VERSION, ...frame }) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

class FakeTimer implements TransportTimer {
  readonly scheduled: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];

  set(callback: () => void, delay: number): unknown {
    const entry = { callback, delay, cleared: false };
    this.scheduled.push(entry);
    return entry;
  }

  clear(timer: unknown): void {
    (timer as { cleared: boolean }).cleared = true;
  }

  run(index: number): void {
    const entry = this.scheduled[index];
    if (entry && !entry.cleared) {
      entry.callback();
    }
  }
}

function createFrame(): ClientFrame {
  return {
    version: TRANSPORT_VERSION,
    type: 'create',
    roomId,
    credential,
    requestId,
  };
}

function resumeFrame(): ClientFrame {
  return {
    version: TRANSPORT_VERSION,
    type: 'resume',
    roomId,
    role: 'sender',
    credential,
    requestId: 'S'.repeat(22),
  };
}

function readyFrame() {
  return {
    type: 'ready',
    requestId,
    mode: 'created',
    snapshot: {
      state: 'WAITING',
      deadline: 1_000_000,
      senderConnected: true,
      receiverConnected: false,
      items: [],
      pairing: null,
    },
  };
}

test('transport reconnects with backoff and uses resume after ready', async () => {
  const sockets: FakeSocket[] = [];
  const timer = new FakeTimer();
  const statuses: string[] = [];
  const transport = new RelayTransport({
    url: 'ws://example/ws',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    timer,
    onFrame: () => {},
    onStatus: (status) => statuses.push(status),
    onTerminal: () => assert.fail('unexpected terminal state'),
  });

  transport.start(createFrame(), resumeFrame);
  sockets[0]?.open();
  assert.equal(JSON.parse(sockets[0]?.sent[0] ?? '{}').type, 'create');
  sockets[0]?.message(readyFrame());
  await new Promise((resolve) => setImmediate(resolve));

  sockets[0]?.drop();
  assert.equal(timer.scheduled[0]?.delay, 250);
  timer.run(0);
  sockets[1]?.open();
  assert.equal(JSON.parse(sockets[1]?.sent[0] ?? '{}').type, 'resume');
  assert.deepEqual(statuses, ['connecting', 'connected', 'reconnecting', 'reconnecting']);

  transport.close();
});

test('unresolved request keeps its identifier and replays after resume', async () => {
  const sockets: FakeSocket[] = [];
  const timer = new FakeTimer();
  const transport = new RelayTransport({
    url: 'ws://example/ws',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    timer,
    onFrame: () => {},
    onStatus: () => {},
    onTerminal: () => assert.fail('unexpected terminal state'),
  });

  transport.start(createFrame(), resumeFrame);
  sockets[0]?.open();
  sockets[0]?.message(readyFrame());
  await Promise.resolve();

  const extend: ClientFrame = {
    version: TRANSPORT_VERSION,
    type: 'extend',
    requestId: 'E'.repeat(22),
  };
  const result = transport.request(extend);
  assert.equal(JSON.parse(sockets[0]?.sent.at(-1) ?? '{}').requestId, extend.requestId);

  sockets[0]?.drop();
  timer.run(0);
  sockets[1]?.open();
  sockets[1]?.message({ ...readyFrame(), mode: 'resumed' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(JSON.parse(sockets[1]?.sent.at(-1) ?? '{}').requestId, extend.requestId);
  sockets[1]?.message({ type: 'ack', requestId: extend.requestId });
  assert.equal(await result, true);

  transport.close();
});

test('transport serializes asynchronous inbound handlers', async () => {
  const socket = new FakeSocket();
  const started: string[] = [];
  const completed: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const transport = new RelayTransport({
    url: 'ws://example/ws',
    createSocket: () => socket,
    onFrame: async (frame) => {
      started.push(frame.type);
      if (frame.type === 'rejected') {
        await firstBlocked;
      }
      completed.push(frame.type);
    },
    onStatus: () => {},
    onTerminal: () => assert.fail('unexpected terminal state'),
  });

  transport.start(createFrame(), resumeFrame);
  socket.open();
  socket.message(readyFrame());
  await new Promise((resolve) => setImmediate(resolve));
  started.length = 0;
  completed.length = 0;

  socket.message({ type: 'rejected' });
  socket.message({ type: 'room_ended', reason: 'expired' });
  await Promise.resolve();
  assert.deepEqual(started, ['rejected']);

  releaseFirst?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['rejected', 'room_ended']);
  assert.deepEqual(completed, ['rejected', 'room_ended']);

  transport.close();
});

test('transport stops at the conservative grace deadline and clears pending work', async () => {
  const socket = new FakeSocket();
  const timer = new FakeTimer();
  let now = 1_000;
  let terminal = '';
  const transport = new RelayTransport({
    url: 'ws://example/ws',
    createSocket: () => socket,
    now: () => now,
    random: () => 0.5,
    timer,
    onFrame: () => {},
    onStatus: () => {},
    onTerminal: (reason) => {
      terminal = reason;
    },
  });

  transport.start(createFrame(), resumeFrame);
  socket.open();
  socket.message(readyFrame());
  await Promise.resolve();

  const pending = transport.request({
    version: TRANSPORT_VERSION,
    type: 'extend',
    requestId: 'E'.repeat(22),
  });
  socket.drop();
  now += RECONNECT_GRACE_MS + HEARTBEAT_ALLOWANCE_MS;
  timer.run(0);

  assert.equal(terminal, 'grace_expired');
  assert.equal(await pending, false);
});

test('intentional close cancels timers and ignores stale socket callbacks', async () => {
  const socket = new FakeSocket();
  const timer = new FakeTimer();
  let frames = 0;
  const transport = new RelayTransport({
    url: 'ws://example/ws',
    createSocket: () => socket,
    timer,
    onFrame: () => {
      frames += 1;
    },
    onStatus: () => {},
    onTerminal: () => {},
  });

  transport.start(createFrame(), resumeFrame);
  socket.open();
  socket.drop();
  transport.close();
  timer.run(0);
  socket.message({ type: 'rejected' });
  await Promise.resolve();

  assert.equal(timer.scheduled[0]?.cleared, true);
  assert.equal(frames, 0);
});
