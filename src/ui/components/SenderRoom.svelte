<script lang="ts">
  import qrcode from 'qrcode-generator';
  import type { RoomState } from '../../shared/protocol';
  import type { ConnectionState, Item } from '../session/model';
  import SecretCard from './SecretCard.svelte';

  export let link: string;
  export let pin: string;
  export let state: RoomState;
  export let connection: ConnectionState;
  export let deadline: number;
  export let items: Item[];
  export let canApprove: boolean;
  export let onApprove: () => void;
  export let onReject: () => void;
  export let onSend: (label: string, value: string, ttl: number) => Promise<boolean>;
  export let onRevoke: (id: string) => void;
  export let onExtend: () => void;
  export let onEnd: () => void;

  let canvas: HTMLCanvasElement;
  let linkInput: HTMLInputElement;
  let label = '';
  let value = '';
  let ttl = 60;
  let copied = false;
  let copyFailed = false;
  let sending = false;

  $: connected = connection === 'connected';
  $: statusText = connectionLabel(connection, state);
  $: canUseRoom = connected && !sending;
  $: if (canvas && link) drawQrCode();

  function connectionLabel(connectionState: ConnectionState, roomState: RoomState): string {
    if (connectionState === 'connecting') {
      return 'Connecting';
    }
    if (connectionState === 'reconnecting') {
      return 'Reconnecting';
    }
    if (connectionState === 'terminal') {
      return 'Disconnected';
    }
    if (roomState === 'WAITING') {
      return 'Waiting for Receiver';
    }
    if (roomState === 'PAIR_PENDING') {
      return 'Pairing request';
    }
    if (roomState === 'PAIRED') {
      return 'Paired';
    }
    if (roomState === 'RECEIVER_GRACE') {
      return 'Receiver reconnecting';
    }
    return 'Sender reconnecting';
  }

  function drawQrCode(): void {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();

    const scale = 4;
    const quietZone = 4;
    canvas.width = canvas.height = (qr.getModuleCount() + quietZone * 2) * scale;

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#101827';

    for (let row = 0; row < qr.getModuleCount(); row += 1) {
      for (let column = 0; column < qr.getModuleCount(); column += 1) {
        if (qr.isDark(row, column)) {
          context.fillRect((column + quietZone) * scale, (row + quietZone) * scale, scale, scale);
        }
      }
    }
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      copyFailed = false;
    } catch {
      copied = false;
      copyFailed = true;
      linkInput.focus();
      linkInput.select();
    }
  }

  async function send(): Promise<void> {
    if (!canUseRoom || !label || !value) {
      return;
    }

    sending = true;
    const submittedLabel = label;
    const submittedValue = value;

    if (await onSend(submittedLabel, submittedValue, ttl)) {
      if (label === submittedLabel) {
        label = '';
      }
      if (value === submittedValue) {
        value = '';
      }
    }

    sending = false;
  }
</script>

<section class="room-page">
  <header class="room-header">
    <div>
      <p class="section-label">Sender room</p>
      <h1>{state === 'PAIRED' ? 'Send encrypted text' : 'Pair a receiver'}</h1>
    </div>

    <div class="room-meta status" aria-live="polite" aria-atomic="true">
      <span class:connected>{statusText}</span>
      {#if deadline > 0}
        <time datetime={new Date(deadline).toISOString()}>
          Ends {new Date(deadline).toLocaleTimeString()}
        </time>
      {/if}
    </div>
  </header>

  {#if connection === 'reconnecting'}
    <p class="connection-notice" role="status">
      Connection lost. KeyBridge will retry during the reconnect period.
    </p>
  {/if}

  {#if state === 'WAITING' || state === 'PAIR_PENDING' || state === 'RECEIVER_GRACE'}
    <div class="pairing-layout">
      <section class="qr-panel">
        <div class="panel-heading">
          <h2>Scan to pair</h2>
          <p>Open the camera on the Receiver device.</p>
        </div>

        <canvas bind:this={canvas} aria-label="Pairing QR code"></canvas>

        <div class="link-field">
          <label for="pairing-link">Pairing link</label>
          <div>
            <input
              bind:this={linkInput}
              id="pairing-link"
              readonly
              value={link}
              aria-label="Pairing link"
            />
            <button class="button secondary" type="button" onclick={copyLink}>Copy</button>
          </div>
          <small>The link contains the room key. Share the PIN separately.</small>

          {#if copied}
            <small class="success-note" role="status">Link copied.</small>
          {/if}
          {#if copyFailed}
            <small class="error-note" role="alert">
              Copy failed. The pairing link is selected for manual copy.
            </small>
          {/if}
        </div>
      </section>

      <aside class="pin-panel">
        <p class="section-label">Separate PIN</p>
        <h2 class="pin">
          <strong>{pin.slice(0, 4)}<span>-</span>{pin.slice(4)}</strong>
        </h2>
        <p>Compare this code through a different channel before you approve the Receiver.</p>

        {#if state === 'PAIR_PENDING'}
          <div class="approval-card">
            {#if canApprove}
              <strong>PIN verified</strong>
              <p>A Receiver supplied the correct PIN. Approve this device?</p>
              <div>
                <button
                  class="button primary"
                  type="button"
                  disabled={!connected}
                  onclick={onApprove}
                >
                  Approve Receiver
                </button>
                <button class="button ghost" type="button" disabled={!connected} onclick={onReject}>
                  Reject
                </button>
              </div>
            {:else}
              <strong>Pairing request received</strong>
              <p>Authentication has not succeeded. Wait for the Receiver to enter the PIN.</p>
              <button class="button ghost" type="button" disabled={!connected} onclick={onReject}>
                Reject request
              </button>
            {/if}
          </div>
        {/if}
      </aside>
    </div>
  {:else if state === 'PAIRED'}
    <section class="send-panel">
      <div class="panel-heading">
        <h2>New secret</h2>
        <p>Text remains available only until its expiry time.</p>
      </div>

      <form
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div class="send-form">
          <label>
            Label
            <input
              maxlength="120"
              autocomplete="off"
              placeholder="For example, recovery code"
              bind:value={label}
            />
          </label>

          <label>
            Expires
            <select bind:value={ttl}>
              <option value={30}>30 seconds</option>
              <option value={60}>1 minute</option>
              <option value={120}>2 minutes</option>
              <option value={300}>5 minutes</option>
            </select>
          </label>

          <label class="secret-input">
            Secret text
            <textarea
              maxlength="65536"
              rows="6"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste or type secret text"
              bind:value
            ></textarea>
          </label>
        </div>

        <button
          class="button primary"
          type="submit"
          disabled={!connected || sending || !label || !value}
        >
          {sending ? 'Encrypting…' : 'Send secret'} <span aria-hidden="true">→</span>
        </button>
      </form>
    </section>
  {/if}

  <div class="room-actions">
    <button class="button ghost" type="button" disabled={!connected} onclick={onExtend}>
      Extend 10 minutes
    </button>
    <button class="button danger" type="button" onclick={onEnd}>End room</button>
  </div>

  {#if items.length > 0}
    <section class="secret-list">
      <div class="list-heading">
        <h2>Active secrets</h2>
        <span>{items.length} active</span>
      </div>

      {#each items as item (item.id)}
        <SecretCard {item} disabled={!connected} {onRevoke} />
      {/each}
    </section>
  {/if}
</section>

<style>
  .room-page {
    max-width: 60rem;
    margin: 0 auto;
  }

  .room-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1.5rem;
    margin-bottom: 2rem;
  }

  .room-header h1 {
    margin-bottom: 0;
  }

  .room-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--text-faint);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .room-meta span {
    border-radius: 999px;
    background: var(--surface-muted);
    padding: 0.3rem 0.625rem;
    color: var(--text-muted);
    font-size: 0.6875rem;
    font-weight: 800;
    letter-spacing: 0.05em;
  }

  .room-meta span.connected {
    background: var(--accent-soft);
    color: var(--accent-strong);
  }

  .pairing-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(16rem, 0.68fr);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }

  .qr-panel,
  .pin-panel {
    padding: clamp(1.5rem, 4vw, 2.5rem) 0;
  }

  .qr-panel {
    padding-right: clamp(1.5rem, 5vw, 4rem);
  }

  .pin-panel {
    border-left: 1px solid var(--border);
    padding-left: clamp(1.5rem, 5vw, 4rem);
  }

  .panel-heading p {
    margin-bottom: 0;
    font-size: 0.8125rem;
  }

  canvas {
    display: block;
    width: min(100%, 15rem);
    height: auto;
    margin: 1.75rem 0;
    background: var(--surface);
    image-rendering: pixelated;
  }

  .link-field label,
  .send-form label {
    display: block;
    color: #334155;
    font-size: 0.75rem;
    font-weight: 750;
  }

  .link-field > div {
    display: flex;
    gap: 0.5rem;
    margin: 0.45rem 0 0.55rem;
  }

  .link-field small {
    display: block;
    color: var(--text-faint);
    font-size: 0.6875rem;
    line-height: 1.5;
  }

  .pin-panel h2 {
    margin: 1.25rem 0;
    color: var(--accent-strong);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: clamp(1.7rem, 4vw, 2.5rem);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.05em;
  }

  .pin-panel h2 span {
    color: #a7f3d0;
  }

  .pin-panel > p:not(.section-label) {
    max-width: 20rem;
    margin-bottom: 0;
    font-size: 0.8125rem;
  }

  .approval-card {
    margin-top: 1.75rem;
    border-top: 1px solid var(--border);
    padding-top: 1.25rem;
  }

  .approval-card strong {
    color: var(--accent-strong);
    font-size: 0.8125rem;
  }

  .approval-card p {
    margin: 0.4rem 0 0.875rem;
    font-size: 0.8125rem;
  }

  .approval-card > div {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .send-panel {
    max-width: 46rem;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 2rem 0;
  }

  .send-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 10rem;
    gap: 1rem;
    margin: 1.5rem 0;
  }

  .send-form .secret-input {
    grid-column: 1 / -1;
  }

  .send-form input,
  .send-form textarea,
  .send-form select {
    display: block;
    margin-top: 0.45rem;
  }

  .send-form textarea {
    resize: vertical;
  }

  @media (max-width: 700px) {
    .room-header {
      align-items: flex-start;
      flex-direction: column;
      gap: 1rem;
    }

    .room-meta {
      flex-wrap: wrap;
    }

    .pairing-layout,
    .send-form {
      grid-template-columns: 1fr;
    }

    .qr-panel {
      padding-right: 0;
    }

    .pin-panel {
      border-top: 1px solid var(--border);
      border-left: 0;
      padding-left: 0;
    }

    .send-form .secret-input {
      grid-column: auto;
    }
  }

  @media (max-width: 430px) {
    .link-field > div {
      align-items: stretch;
      flex-direction: column;
    }

    .link-field > div :global(.button) {
      width: 100%;
    }
  }
</style>
