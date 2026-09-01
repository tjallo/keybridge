<script lang="ts">
  import qrcode from 'qrcode-generator';
  import SecretCard from './SecretCard.svelte';
  export let link: string;
  export let pin: string;
  export let state: string;
  export let deadline: number;
  export let items: { id: string; label: string; value: string; expiresAt: number; ttl: number }[];
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

<section>
  <div class="status">
    <span class:online={state === 'PAIRED'}>{state.replaceAll('_', ' ')}</span><span
      >Room ends {new Date(deadline).toLocaleTimeString()}</span
    >
  </div>
  {#if state === 'WAITING' || state === 'PAIR_PENDING'}<div class="grid">
      <div class="panel">
        <h1>Pair a Receiver</h1>
        <canvas bind:this={canvas} aria-label="Pairing QR code"></canvas>
        <p>Pairing link (contains the room key)</p>
        <input bind:this={linkInput} readonly value={link} aria-label="Pairing link" /><button
          onclick={copyLink}>Copy full link</button
        >{#if copied}<small>Copied. Share the PIN separately when practical.</small>{/if}
        {#if copyFailed}<small role="alert"
            >Copy failed. The pairing link is selected for manual copy.</small
          >{/if}
      </div>
      <div class="panel pin">
        <h2>Separate PIN</h2>
        <strong>{pin.slice(0, 4)}-{pin.slice(4)}</strong>
        <p>Compare this PIN using a separate channel.</p>
        {#if state === 'PAIR_PENDING'}<div class="approval">
            {#if canApprove}<p>A Receiver supplied the correct PIN. Approve this device?</p>
              <button class="primary" onclick={onApprove}>Approve</button>{:else}<p>
                A Receiver is attempting to pair. Authentication has not succeeded.
              </p>{/if}
            <button onclick={onReject}>Reject</button>
          </div>{/if}
      </div>
    </div>{/if}
  {#if state === 'PAIRED'}<div class="panel">
      <h1>Send immutable text</h1>
      <label>Label<input maxlength="120" bind:value={label} /></label><label
        >Secret text<textarea maxlength="65536" rows="7" bind:value></textarea></label
      ><label
        >Expires<select bind:value={ttl}
          ><option value={30}>30 seconds</option><option value={60}>60 seconds</option><option
            value={120}>2 minutes</option
          ><option value={300}>5 minutes</option></select
        ></label
      ><button class="primary" disabled={sending || !label || !value} onclick={send}
        >{sending ? 'Sending…' : 'Send secret'}</button
      >
    </div>{/if}
  <div class="toolbar">
    <button onclick={onExtend}>Extend room 10 minutes</button><button class="danger" onclick={onEnd}
      >End room</button
    >
  </div>
  {#each items as item (item.id)}<SecretCard {item} {onRevoke} />{/each}
</section>
