<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import StartRoom from './components/StartRoom.svelte';
  import SenderRoom from './components/SenderRoom.svelte';
  import ReceiverRoom from './components/ReceiverRoom.svelte';
  import {
    base64url,
    fromBase64url,
    randomBytes,
    randomId,
    generatePin,
    derivePairingKey,
    deriveSessionKeys,
    encryptJson,
    decryptJson,
    encodePlaintext,
    ReplayGuard,
    normalizePin,
    type SessionKeys,
  } from './crypto';
  import type { EncryptedEnvelope } from '../shared/envelope';
  import { isEnvelope, matchesEnvelope, MAX_PLAINTEXT_BYTES } from '../shared/envelope';
  type Item = {
    id: string;
    label: string;
    value: string;
    createdAt: number;
    expiresAt: number;
    ttl: number;
  };
  type Stored = {
    role: 'sender' | 'receiver';
    roomId: string;
    roomKey: string;
    pin: string;
    credential: string;
    receiverNonce?: string;
    senderNonce?: string;
  };
  let releaseAssets: Record<string, string> = {};
  let view: 'start' | 'sender' | 'receiver' | 'security' = 'start';
  let roomId = '',
    roomKey = '',
    pin = '',
    credential = '',
    link = '',
    roomState = 'WAITING',
    receiverView = 'PIN',
    deadline = 0,
    error = '',
    canApprove = false;
  let pendingReceiverNonce = '',
    senderNonce = '';
  let socket: WebSocket | null = null;
  let pairingKey: CryptoKey | null = null;
  let keys: SessionKeys | null = null;
  let items: Item[] = [];
  const itemReplay = new ReplayGuard();
  const pairingReplay = new ReplayGuard();
  const controlReplay = new ReplayGuard();
  const pendingMutations = new Map<
    string,
    { resolve: (accepted: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let restoring = false,
    resumeRetries = 0,
    rejectedClose = false;
  let restoreCommand: object | null = null;
  const request = () => randomId();
  const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const send = (value: object) => socket?.send(JSON.stringify({ version: 1, ...value }));
  const relayErrorMessage = (code: unknown): string => {
    switch (code) {
      case 'busy':
        return 'This room is full. End an active secret or try again later.';
      case 'expired':
        return 'This room has expired.';
      case 'not_allowed':
        return 'This action is not available in the current room state.';
      case 'rate_limited':
        return 'Too many requests. Wait a moment and try again.';
      case 'room_unavailable':
        return 'This room is no longer available.';
      case 'unsupported_version':
        return 'This browser uses an unsupported protocol version.';
      default:
        return 'The Relay could not process the request.';
    }
  };
  const roomEndMessage = (reason: unknown): string => {
    if (reason === 'expired') return 'The room has expired.';
    if (reason === 'busy') return 'The room ended because it reached its capacity limit.';
    if (reason === 'shutdown') return 'The Relay restarted. Create a new room to continue.';
    return 'The room has ended.';
  };
  function save() {
    if (view !== 'sender' && view !== 'receiver') return;
    const data: Stored = { role: view, roomId, roomKey, pin, credential };
    if (pendingReceiverNonce) data.receiverNonce = pendingReceiverNonce;
    if (senderNonce) data.senderNonce = senderNonce;
    sessionStorage.setItem('keybridge.room', JSON.stringify(data));
  }
  function clear() {
    sessionStorage.removeItem('keybridge.room');
    for (const pending of pendingMutations.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    pendingMutations.clear();
    roomKey = '';
    pin = '';
    credential = '';
    keys = null;
    pairingKey = null;
    items = [];
  }
  function connect(first: object) {
    socket = new WebSocket(wsUrl());
    socket.onopen = () => send(first);
    socket.onmessage = (event) =>
      void handle(JSON.parse(String(event.data)) as Record<string, unknown>);
    socket.onclose = (event) => {
      if (event.code === 4000 && rejectedClose) {
        rejectedClose = false;
        setTimeout(() => connect({ type: 'join', roomId, requestId: request() }), 200);
      } else if (event.code !== 1000 && event.code !== 4001 && !restoring)
        error = 'Connection lost. Reload within 60 seconds to reconnect.';
    };
  }
  function sendMutation(command: Record<string, unknown>): Promise<boolean> {
    const requestId = request();
    send({ ...command, requestId });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingMutations.delete(requestId);
        resolve(false);
      }, 5000);
      pendingMutations.set(requestId, { resolve, timer });
    });
  }
  function finishMutation(requestId: unknown, accepted: boolean): void {
    if (typeof requestId !== 'string') return;
    const pending = pendingMutations.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingMutations.delete(requestId);
    pending.resolve(accepted);
  }
  function retryResume(): void {
    if (!restoreCommand) return;
    socket?.close(1000);
    if (resumeRetries++ < 8) setTimeout(() => connect(restoreCommand!), 250);
    else {
      restoring = false;
      restoreCommand = null;
      clear();
      view = 'start';
      error = 'The saved Room has expired or is no longer available.';
    }
  }
  async function createRoom() {
    clear();
    view = 'sender';
    roomId = base64url(randomBytes(16));
    roomKey = base64url(randomBytes(32));
    pin = generatePin();
    pairingKey = await derivePairingKey(fromBase64url(roomKey), roomId, pin);
    link = `${location.origin}/#room=${roomId}&key=${roomKey}`;
    connect({ type: 'create', roomId, requestId: request() });
  }
  async function importFragment(): Promise<boolean> {
    const params = new URLSearchParams(location.hash.slice(1));
    const id = params.get('room'),
      key = params.get('key');
    if (!id || !key) return false;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      if (
        !/^[A-Za-z0-9_-]{22}$/.test(id) ||
        !/^[A-Za-z0-9_-]{43}$/.test(key) ||
        fromBase64url(key).length !== 32
      )
        throw new Error('invalid link');
    } catch {
      error = 'Invalid pairing link.';
      return true;
    }
    view = 'receiver';
    roomId = id;
    roomKey = key;
    connect({ type: 'join', roomId, requestId: request() });
    return true;
  }
  async function restore(stored: Stored) {
    view = stored.role;
    roomId = stored.roomId;
    roomKey = stored.roomKey;
    pin = stored.pin;
    credential = stored.credential;
    pendingReceiverNonce = stored.receiverNonce ?? '';
    senderNonce = stored.senderNonce ?? '';
    pairingKey = await derivePairingKey(fromBase64url(roomKey), roomId, pin);
    if (pendingReceiverNonce && senderNonce)
      keys = await deriveSessionKeys(pairingKey, roomId, pendingReceiverNonce, senderNonce);
    if (view === 'sender') {
      link = `${location.origin}/#room=${roomId}&key=${roomKey}`;
      canApprove = Boolean(pendingReceiverNonce && !senderNonce);
    }
    restoring = true;
    restoreCommand =
      view === 'receiver' && !credential
        ? { type: 'join', roomId, requestId: request() }
        : { type: 'resume', roomId, role: view, credential, requestId: request() };
    connect(restoreCommand);
  }
  async function submitPin(value: string) {
    try {
      pin = normalizePin(value);
      pairingKey = await derivePairingKey(fromBase64url(roomKey), roomId, pin);
      pendingReceiverNonce = randomId();
      const envelope = await encryptJson(
        pairingKey,
        { roomId, direction: 'receiver-to-sender', kind: 'pair-request', expiresAt: null },
        { receiverNonce: pendingReceiverNonce },
      );
      send({ type: 'pair', envelope, requestId: request() });
      receiverView = 'PENDING';
      save();
    } catch {
      error = 'The PIN format is invalid.';
    }
  }
  async function approve() {
    if (!pairingKey) return;
    senderNonce = randomId();
    keys = await deriveSessionKeys(pairingKey, roomId, pendingReceiverNonce, senderNonce);
    const envelope = await encryptJson(
      pairingKey,
      { roomId, direction: 'sender-to-receiver', kind: 'pair-response', expiresAt: null },
      { approved: true, receiverNonce: pendingReceiverNonce, senderNonce },
    );
    send({ type: 'approve', envelope, requestId: request() });
    canApprove = false;
    save();
  }
  async function handle(message: Record<string, unknown>) {
    if (message.type === 'error') {
      finishMutation(message.requestId, false);
      if (restoring && message.code === 'room_unavailable') {
        retryResume();
        return;
      }
      error = relayErrorMessage(message.code);
      return;
    }
    if (message.type === 'created') {
      credential = String(message.credential);
      deadline = Number(message.deadline);
      roomState = String(message.state);
      save();
      return;
    }
    if (message.type === 'joined') {
      restoring = false;
      restoreCommand = null;
      receiverView = 'PIN';
      return;
    }
    if (message.type === 'room_state') {
      const nextState = String(message.state);
      if (view === 'sender' && roomState === 'RECEIVER_GRACE' && nextState === 'WAITING') {
        await rotatePin();
      }
      roomState = nextState;
      deadline = Number(message.deadline);
      return;
    }
    if (message.type === 'pair_request' && view === 'sender' && pairingKey) {
      try {
        const envelope = message.envelope as EncryptedEnvelope;
        if (
          !isEnvelope(envelope) ||
          pairingReplay.has(envelope.messageId) ||
          !matchesEnvelope(envelope, {
            roomId,
            direction: 'receiver-to-sender',
            kind: 'pair-request',
            expiresAt: 'null',
          })
        )
          throw new Error('invalid pairing envelope');
        const body = await decryptJson<{ receiverNonce: string }>(pairingKey, envelope);
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(body.receiverNonce))
          throw new Error('invalid receiver nonce');
        pairingReplay.commit(envelope.messageId);
        pendingReceiverNonce = body.receiverNonce;
        canApprove = true;
        roomState = 'PAIR_PENDING';
        save();
      } catch {
        error = 'Pairing authentication failed. Ask the Receiver to check the PIN.';
      }
      return;
    }
    if (message.type === 'approved' && view === 'receiver' && pairingKey) {
      try {
        const envelope = message.envelope as EncryptedEnvelope;
        if (
          !isEnvelope(envelope) ||
          pairingReplay.has(envelope.messageId) ||
          !matchesEnvelope(envelope, {
            roomId,
            direction: 'sender-to-receiver',
            kind: 'pair-response',
            expiresAt: 'null',
          })
        )
          throw new Error('invalid approval envelope');
        const body = await decryptJson<{
          approved: boolean;
          receiverNonce: string;
          senderNonce: string;
        }>(pairingKey, envelope);
        if (
          body.receiverNonce !== pendingReceiverNonce ||
          !body.approved ||
          !/^[A-Za-z0-9_-]{16,64}$/.test(body.senderNonce)
        )
          throw new Error();
        pairingReplay.commit(envelope.messageId);
        senderNonce = body.senderNonce;
        keys = await deriveSessionKeys(pairingKey, roomId, pendingReceiverNonce, senderNonce);
        credential = String(message.credential);
        receiverView = 'PAIRED';
        roomState = 'PAIRED';
        save();
      } catch {
        error = 'Approval authentication failed.';
      }
      return;
    }
    if (message.type === 'rejected') {
      error = 'The Sender rejected this pairing request. Enter the new PIN to try again.';
      receiverView = 'REJOINING';
      pin = '';
      pendingReceiverNonce = '';
      credential = '';
      rejectedClose = true;
      save();
      return;
    }
    if (message.type === 'ack') finishMutation(message.requestId, true);
    if (message.type === 'ack' && message.state) roomState = String(message.state);
    if (message.type === 'ack' && message.deadline) deadline = Number(message.deadline);
    if (message.type === 'resumed') {
      restoring = false;
      restoreCommand = null;
      roomState = String(message.state);
      deadline = Number(message.deadline);
      if (view === 'receiver') receiverView = 'PAIRED';
      if (view === 'sender' && roomState === 'WAITING' && keys) await rotatePin();
      for (const envelope of message.items as EncryptedEnvelope[]) await receiveItem(envelope);
      return;
    }
    if (message.type === 'item') await receiveItem(message.envelope as EncryptedEnvelope);
    if (message.type === 'revoked') await receiveRevocation(message);
    if (message.type === 'room_ended') {
      clear();
      view = 'start';
      error = roomEndMessage(message.reason);
    }
  }
  async function receiveItem(envelope: EncryptedEnvelope) {
    if (
      !keys ||
      !isEnvelope(envelope) ||
      itemReplay.has(envelope.messageId) ||
      !matchesEnvelope(envelope, {
        roomId,
        direction: 'sender-to-receiver',
        kind: 'item',
        expiresAt: 'present',
      }) ||
      envelope.expiresAt === null ||
      envelope.expiresAt <= Date.now()
    )
      return;
    try {
      const item = await decryptJson<Item & Record<string, unknown>>(keys.item, envelope);
      if (
        item.expiresAt !== envelope.expiresAt ||
        item.id !== envelope.messageId ||
        typeof item.id !== 'string' ||
        typeof item.label !== 'string' ||
        typeof item.value !== 'string' ||
        typeof item.createdAt !== 'number' ||
        ![30, 60, 120, 300].includes(item.ttl) ||
        item.expiresAt !== item.createdAt + item.ttl * 1000 ||
        new TextEncoder().encode(JSON.stringify(item)).length > MAX_PLAINTEXT_BYTES
      )
        return;
      itemReplay.commit(envelope.messageId);
      items = [...items.filter((old) => old.id !== item.id), item];
    } catch {
      error = 'An encrypted item failed authentication.';
    }
  }
  async function sendItem(label: string, value: string, ttl: number): Promise<boolean> {
    if (!keys || ![30, 60, 120, 300].includes(ttl)) return false;
    const createdAt = Date.now(),
      expiresAt = createdAt + ttl * 1000,
      id = randomId();
    const item: Item = { id, label, value, createdAt, expiresAt, ttl };
    const fields = {
      roomId,
      messageId: id,
      direction: 'sender-to-receiver' as const,
      kind: 'item' as const,
      expiresAt,
    };
    if (encodePlaintext(fields, item).length > MAX_PLAINTEXT_BYTES) {
      error = 'The complete item plaintext exceeds 64 KiB.';
      return false;
    }
    const envelope = await encryptJson(keys.item, fields, item);
    if (!(await sendMutation({ type: 'item', envelope }))) {
      error = 'The Relay did not accept this item. Your input has been preserved.';
      return false;
    }
    itemReplay.commit(id);
    items = [...items, item];
    return true;
  }
  async function receiveRevocation(message: Record<string, unknown>): Promise<void> {
    if (!keys || typeof message.itemId !== 'string') return;
    const envelope = message.envelope as EncryptedEnvelope;
    const direction = view === 'sender' ? 'receiver-to-sender' : 'sender-to-receiver';
    const key = view === 'sender' ? keys.receiverControl : keys.senderControl;
    if (
      !isEnvelope(envelope) ||
      controlReplay.has(envelope.messageId) ||
      !matchesEnvelope(envelope, { roomId, direction, kind: 'control', expiresAt: 'null' })
    )
      return;
    try {
      const body = await decryptJson<{ itemId: string }>(key, envelope);
      if (body.itemId !== message.itemId) throw new Error('control item mismatch');
      controlReplay.commit(envelope.messageId);
      items = items.filter((item) => item.id !== body.itemId);
    } catch {
      error = 'A control message failed authentication.';
    }
  }
  async function rotatePin() {
    pin = generatePin();
    pairingKey = await derivePairingKey(fromBase64url(roomKey), roomId, pin);
    pendingReceiverNonce = '';
    senderNonce = '';
    keys = null;
    canApprove = false;
    save();
  }
  async function rejectPairing() {
    send({ type: 'reject', requestId: request() });
    await rotatePin();
  }
  async function revoke(id: string): Promise<void> {
    if (!keys) return;
    const sender = view === 'sender';
    const envelope = await encryptJson(
      sender ? keys.senderControl : keys.receiverControl,
      {
        roomId,
        direction: sender ? 'sender-to-receiver' : 'receiver-to-sender',
        kind: 'control',
        expiresAt: null,
      },
      { itemId: id },
    );
    if (await sendMutation({ type: 'revoke', itemId: id, envelope }))
      items = items.filter((item) => item.id !== id);
    else error = 'The Relay did not acknowledge revocation.';
  }
  function end() {
    send({ type: 'end', requestId: request() });
    clear();
    view = 'start';
  }
  function leave() {
    send({ type: 'leave', requestId: request() });
    clear();
    view = 'start';
  }
  const expiry = setInterval(
    () => (items = items.filter((item) => item.expiresAt > Date.now())),
    1000,
  );
  onDestroy(() => {
    clearInterval(expiry);
    socket?.close(1000);
  });
  onMount(async () => {
    fetch('/release.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.assets) releaseAssets = data.assets;
      })
      .catch(() => {});
    if (await importFragment()) return;
    const raw = sessionStorage.getItem('keybridge.room');
    if (raw)
      try {
        await restore(JSON.parse(raw) as Stored);
      } catch {
        clear();
        error = 'The saved room could not be restored.';
      }
  });
</script>

<header class="site-header">
  <div class="site-nav">
    <button
      class="brand"
      onclick={() => {
        if (view === 'start' || view === 'security') view = 'start';
      }}
    >
      <span class="brand-mark" aria-hidden="true">K</span><span>KeyBridge</span>
    </button>
    <nav aria-label="Project links">
      <a
        class="source-link"
        href="https://github.com/tjallo/keybridge"
        rel="noreferrer"
        target="_blank"
        ><svg viewBox="0 0 16 16" aria-hidden="true"
          ><path
            d="M8 1.2a6.8 6.8 0 0 0-2.15 13.25c.34.06.46-.14.46-.33v-1.2c-1.88.4-2.28-.8-2.28-.8-.3-.78-.76-.99-.76-.99-.62-.42.05-.41.05-.41.68.05 1.04.7 1.04.7.62 1.03 1.6.73 2 .56.06-.43.24-.73.44-.9-1.5-.16-3.08-.73-3.08-3.3 0-.73.27-1.33.7-1.8-.07-.17-.3-.86.07-1.78 0 0 .57-.18 1.86.69A6.5 6.5 0 0 1 8 4.9a6.5 6.5 0 0 1 1.7.23c1.3-.87 1.86-.69 1.86-.69.38.92.15 1.61.08 1.78.43.47.7 1.07.7 1.8 0 2.58-1.58 3.14-3.09 3.3.25.2.46.56.46 1.14v1.68c0 .19.12.4.47.33A6.8 6.8 0 0 0 8 1.2Z"
          /></svg
        ><span>Source</span></a
      ><span class="version">v{__APP_VERSION__}</span>
    </nav>
  </div>
</header>
<main class="page-shell">
  {#if error}<div class="alert" role="alert">
      <span>{error}</span><button aria-label="Dismiss error" onclick={() => (error = '')}>×</button>
    </div>{/if}{#if view === 'start'}<StartRoom
      onCreate={createRoom}
      onSecurity={() => (view = 'security')}
    />{:else if view === 'sender'}<SenderRoom
      {link}
      {pin}
      state={roomState}
      {deadline}
      {items}
      {canApprove}
      onApprove={approve}
      onReject={rejectPairing}
      onSend={sendItem}
      onRevoke={revoke}
      onExtend={() => send({ type: 'extend', requestId: request() })}
      onEnd={end}
    />{:else if view === 'receiver'}<ReceiverRoom
      state={receiverView}
      {items}
      onSubmitPin={submitPin}
      onRevoke={revoke}
      onLeave={leave}
    />{:else}<section class="security-page">
      <div class="section-label">Security</div>
      <h1>Security &amp; transparency</h1>
      <p>
        The published browser client encrypts secret payloads before transmission. The Relay does
        not receive the room key, PIN, or plaintext.
      </p>
      <p>
        The Relay sees network addresses, times, room associations, ciphertext sizes, expiry times,
        and protocol events. The server supplying this page could serve modified JavaScript, so this
        browser app cannot protect against a malicious code-serving server.
      </p>
      <p>
        V1 has no forward secrecy. Clipboard content is not cleared. Browser memory and storage
        cannot guarantee secure erasure.
      </p>
      <div class="build-details">
        Protocol 1 · Version {__APP_VERSION__} · Source {__SOURCE_COMMIT__}
      </div>
      <details>
        <summary>Client asset SHA-256 hashes</summary
        >{#each Object.entries(releaseAssets) as [asset, hash]}<code>{asset}: {hash}</code><br
          />{/each}
      </details>
      <button class="button secondary" onclick={() => (view = 'start')}>Back</button>
    </section>{/if}
</main>
<footer class="site-footer">
  <span>No accounts · No analytics · Session storage only</span>
  <a href="https://github.com/tjallo/keybridge" rel="noreferrer" target="_blank"
    >View source on GitHub</a
  >
</footer>
