<script lang="ts">
  export let item: { id: string; label: string; value: string; expiresAt: number; ttl: number };
  export let receiver = false;
  export let onRevoke: (id: string) => void;
  let revealed = false;
  let copyFailed = false;
  let selected = false;
  let remaining = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000));
  const timer = setInterval(
    () => (remaining = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000))),
    1000,
  );
  import { onDestroy } from 'svelte';
  onDestroy(() => clearInterval(timer));
  async function copy() {
    try {
      await navigator.clipboard.writeText(item.value);
      copyFailed = false;
    } catch {
      revealed = true;
      copyFailed = true;
      selected = true;
    }
  }
</script>

<article class="secret-card" aria-label={`Secret ${item.label}`}>
  <header><strong>{item.label}</strong><span>{remaining}s</span></header>
  <small>Text · {item.ttl}s TTL</small>{#if receiver}<pre class:selected>{revealed
        ? item.value
        : '••••••••••••'}</pre>
    <div class="actions">
      <button onclick={() => (revealed = !revealed)}>{revealed ? 'Hide' : 'Reveal'}</button><button
        onclick={copy}>Copy</button
      ><button class="danger" onclick={() => onRevoke(item.id)}>Revoke</button>
    </div>
    {#if copyFailed}<p role="alert">
        Clipboard access failed. Select the revealed value and copy it manually.
      </p>{/if}{:else}<button class="danger" onclick={() => onRevoke(item.id)}>Revoke</button>{/if}
</article>
