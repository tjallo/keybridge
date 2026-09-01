<script lang="ts">
  import qrcode from 'qrcode-generator';
  import SecretCard from './SecretCard.svelte';

  export let link: string;
  export let pin: string;
  export let state: string;
  export let deadline: number;
  export let items: {
    id: string;
    label: string;
    value: string;
    expiresAt: number;
    ttl: number;
  }[];
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

  function drawQrCode(): void {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();

    const scale = 4;
    const quietZone = 4;

    canvas.width = canvas.height = (qr.getModuleCount() + quietZone * 2) * scale;

    const context = canvas.getContext('2d');
    if (!context) return;

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#101827';

    for (let row = 0; row < qr.getModuleCount(); row++)
      for (let col = 0; col < qr.getModuleCount(); col++)
        if (qr.isDark(row, col))
          context.fillRect((col + quietZone) * scale, (row + quietZone) * scale, scale, scale);
  }

  $: if (canvas && link) drawQrCode();

  async function copyLink() {
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

  async function send() {
    if (sending) return;

    sending = true;

    const submittedLabel = label;
    const submittedValue = value;

    if (await onSend(submittedLabel, submittedValue, ttl)) {
      if (label === submittedLabel) label = '';
      if (value === submittedValue) value = '';
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

    <div class="room-meta status">
      <span class:connected={state === 'PAIRED'}>{state.replaceAll('_', ' ')}</span>
      <time>Ends {new Date(deadline).toLocaleTimeString()}</time>
    </div>
  </header>

  {#if state === 'WAITING' || state === 'PAIR_PENDING'}
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
            <button class="button secondary" onclick={copyLink}>Copy</button>
          </div>

          <small>The link contains the room key. Share the PIN separately.</small>

          {#if copied}
            <small class="success-note">Link copied.</small>
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
                <button class="button primary" onclick={onApprove}>Approve Receiver</button>
                <button class="button ghost" onclick={onReject}>Reject</button>
              </div>
            {:else}
              <strong>Pairing request received</strong>
              <p>Authentication has not succeeded. Wait for the Receiver to enter the PIN.</p>
              <button class="button ghost" onclick={onReject}>Reject request</button>
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

      <div class="send-form">
        <label>
          Label
          <input maxlength="120" placeholder="For example, recovery code" bind:value={label} />
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
            placeholder="Paste or type secret text"
            bind:value
          ></textarea>
        </label>
      </div>

      <button class="button primary" disabled={sending || !label || !value} onclick={send}>
        {sending ? 'Encrypting…' : 'Send secret'} <span aria-hidden="true">→</span>
      </button>
    </section>
  {/if}

  <div class="room-actions">
    <button class="button ghost" onclick={onExtend}>Extend 10 minutes</button>
    <button class="button danger" onclick={onEnd}>End room</button>
  </div>

  {#if items.length > 0}
    <section class="secret-list">
      <div class="list-heading">
        <h2>Active secrets</h2>
        <span>{items.length} active</span>
      </div>

      {#each items as item (item.id)}
        <SecretCard {item} {onRevoke} />
      {/each}
    </section>
  {/if}
</section>
