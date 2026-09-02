<script lang="ts">
  import type { ConnectionState, Item, ReceiverView } from '../session/model';
  import SecretCard from './SecretCard.svelte';

  export let state: ReceiverView;
  export let connection: ConnectionState;
  export let items: Item[];
  export let onSubmitPin: (pin: string) => void;
  export let onRevoke: (id: string) => void;
  export let onLeave: () => void;

  let pin = '';
  $: connected = connection === 'connected';

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (connected && pin) {
      onSubmitPin(pin);
    }
  }
</script>

<section class="receiver-page">
  <header class="receiver-header">
    <p class="section-label">Receiver</p>
    <h1>{state === 'PAIRED' ? 'Your secure inbox' : 'Pair this device'}</h1>
    <p class="receiver-connection" aria-live="polite">
      {#if connection === 'connecting'}
        Connecting to the Relay…
      {:else if connection === 'reconnecting'}
        Connection lost. Retrying during the reconnect period…
      {/if}
    </p>
  </header>

  {#if state === 'PIN'}
    <form class="receiver-card" onsubmit={submit}>
      <div class="receiver-icon" aria-hidden="true">↗</div>
      <h2>Enter the separate PIN</h2>
      <p>Ask the Sender for the eight-character PIN. Do not share it with the pairing link.</p>

      <label class="pin-input">
        PIN
        <input
          autocomplete="one-time-code"
          autocapitalize="characters"
          inputmode="text"
          maxlength="9"
          pattern={'[23456789ABCDEFGHJKMNPQRSTUVWXYZ-]{8,9}'}
          placeholder="XXXX-XXXX"
          required
          spellcheck="false"
          bind:value={pin}
        />
      </label>

      <button class="button primary" type="submit" disabled={!connected || !pin}>
        Request pairing <span aria-hidden="true">→</span>
      </button>
    </form>
  {:else if state === 'PENDING' || state === 'REJOINING'}
    <div class="receiver-card waiting-card" role="status">
      <div class="pulse-dot" aria-hidden="true"></div>
      <h2>{state === 'REJOINING' ? 'Rejoining the room' : 'Waiting for approval'}</h2>
      <p>
        {state === 'REJOINING'
          ? 'KeyBridge is reserving the Receiver slot again.'
          : 'The Sender must approve this device before KeyBridge can deliver secrets.'}
      </p>
    </div>
  {:else if state === 'PAIRED'}
    <div class="receiver-notice">
      <span aria-hidden="true">✓</span>
      <p>Paired. Secret values stay hidden until you reveal them.</p>
    </div>

    {#if items.length === 0}
      <div class="empty-state">
        <div aria-hidden="true">⌁</div>
        <h2>Nothing here yet</h2>
        <p>The Sender can now send encrypted text to this device.</p>
      </div>
    {:else}
      <section class="secret-list">
        <div class="list-heading">
          <h2>Received secrets</h2>
          <span>{items.length} active</span>
        </div>

        {#each items as item (item.id)}
          <SecretCard {item} receiver disabled={!connected} {onRevoke} />
        {/each}
      </section>
    {/if}
  {/if}

  <div class="room-actions receiver-actions">
    <button class="button danger" type="button" onclick={onLeave}>Leave room</button>
  </div>
</section>

<style>
  .receiver-page {
    max-width: 40rem;
    margin: 0 auto;
  }

  .receiver-header {
    margin-bottom: 2rem;
  }

  .receiver-connection {
    min-height: 1.5rem;
    margin: 0;
    color: #92400e;
    font-size: 0.8125rem;
  }

  .receiver-card {
    max-width: 28rem;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 2rem 0;
  }

  .receiver-icon {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    margin-bottom: 1rem;
    border-radius: 0.5rem;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-size: 1.25rem;
  }

  .receiver-card p {
    margin-bottom: 1.5rem;
  }

  .pin-input {
    display: block;
    width: min(100%, 16rem);
    margin-bottom: 1rem;
    color: #334155;
    font-size: 0.75rem;
    font-weight: 750;
  }

  .pin-input input {
    display: block;
    margin-top: 0.45rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 1rem;
    letter-spacing: 0.08em;
  }

  .pulse-dot {
    width: 0.625rem;
    height: 0.625rem;
    margin-bottom: 1rem;
    border-radius: 999px;
    background: #10b981;
    box-shadow: 0 0 0 0 #10b98166;
    animation: pulse 1.8s infinite;
  }

  @keyframes pulse {
    70% {
      box-shadow: 0 0 0 0.65rem #10b98100;
    }
    100% {
      box-shadow: 0 0 0 0 #10b98100;
    }
  }

  .receiver-notice {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    max-width: 40rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 1rem;
  }

  .receiver-notice span {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 999px;
    background: #d1fae5;
    color: var(--accent-strong);
    font-size: 0.75rem;
    font-weight: 800;
  }

  .receiver-notice p {
    margin: 0;
    font-size: 0.8125rem;
  }

  .empty-state {
    max-width: 28rem;
    padding: 4rem 0;
    text-align: center;
  }

  .empty-state > div {
    margin-bottom: 1rem;
    color: #a7f3d0;
    font-size: 2.25rem;
  }

  .empty-state h2 {
    margin-bottom: 0.5rem;
  }

  .empty-state p {
    margin: 0;
  }

  .receiver-actions {
    justify-content: flex-start;
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse-dot {
      animation: none;
    }
  }
</style>
