<script lang="ts">
  import SecretCard from './SecretCard.svelte';
  export let state: string;
  export let items: { id: string; label: string; value: string; expiresAt: number; ttl: number }[];
  export let onSubmitPin: (pin: string) => void;
  export let onRevoke: (id: string) => void;
  export let onLeave: () => void;
  let pin = '';
</script>

<section class="panel">
  <h1>Receiver</h1>
  {#if state === 'PIN'}<p>Enter the separate eight-character PIN shown by the Sender.</p>
    <label
      >PIN<input
        autocomplete="one-time-code"
        maxlength="9"
        placeholder="XXXX-XXXX"
        bind:value={pin}
      /></label
    ><button class="primary" onclick={() => onSubmitPin(pin)}>Request pairing</button
    >{:else if state === 'PENDING'}<p>
      Waiting for Sender approval…
    </p>{:else if state === 'PAIRED'}<p>Paired. Secret values stay hidden until you reveal them.</p>
    {#if items.length === 0}<p>No active secrets.</p>{/if}{#each items as item (item.id)}<SecretCard
        {item}
        receiver
        {onRevoke}
      />{/each}{/if}<button class="danger" onclick={onLeave}>Leave room</button>
</section>
