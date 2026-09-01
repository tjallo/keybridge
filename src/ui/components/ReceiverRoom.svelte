<script lang="ts">
  import SecretCard from './SecretCard.svelte';
  export let state: string;
  export let items: { id: string; label: string; value: string; expiresAt: number; ttl: number }[];
  export let onSubmitPin: (pin: string) => void;
  export let onRevoke: (id: string) => void;
  export let onLeave: () => void;
  let pin = '';
</script>

<section class="receiver-page">
  <header class="receiver-header">
    <p class="section-label">Receiver</p>
    <h1>{state === 'PAIRED' ? 'Your secure inbox' : 'Pair this device'}</h1>
  </header>

  {#if state === 'PIN'}
    <div class="receiver-card">
      <div class="receiver-icon" aria-hidden="true">↗</div>
      <h2>Enter the separate PIN</h2>
      <p>Ask the Sender for the eight-character PIN. Do not share it with the pairing link.</p>
      <label class="pin-input"
        >PIN<input
          autocomplete="one-time-code"
          maxlength="9"
          placeholder="XXXX-XXXX"
          bind:value={pin}
        /></label
      >
      <button class="button primary" onclick={() => onSubmitPin(pin)}
        >Request pairing <span aria-hidden="true">→</span></button
      >
    </div>
  {:else if state === 'PENDING'}
    <div class="receiver-card waiting-card">
      <div class="pulse-dot" aria-hidden="true"></div>
      <h2>Waiting for approval</h2>
      <p>The Sender must approve this device before KeyBridge can deliver secrets.</p>
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
        {#each items as item (item.id)}<SecretCard {item} receiver {onRevoke} />{/each}
      </section>
    {/if}
  {/if}

  <div class="room-actions receiver-actions">
    <button class="button danger" onclick={onLeave}>Leave room</button>
  </div>
</section>
