<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { Item } from '../session/model';

  export let item: Item;
  export let receiver = false;
  export let disabled = false;
  export let onRevoke: (id: string) => void;

  let revealed = false;
  let copyFailed = false;
  let valueElement: HTMLTextAreaElement;
  let remaining = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1_000));

  const timer = setInterval(() => {
    remaining = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1_000));
  }, 1_000);

  onDestroy(() => clearInterval(timer));

  function ttlLabel(ttl: number): string {
    if (ttl < 60) {
      return `${ttl} seconds`;
    }
    if (ttl === 60) {
      return '1 minute';
    }
    return `${ttl / 60} minutes`;
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.value);
      copyFailed = false;
    } catch {
      revealed = true;
      copyFailed = true;
      await tick();
      valueElement.focus();
      valueElement.select();
    }
  }
</script>

<article class="secret-card" aria-label={`Secret ${item.label}`}>
  <header>
    <div>
      <strong>{item.label}</strong>
      <small>Text · expires after {ttlLabel(item.ttl)}</small>
    </div>
    <span class:expiring={remaining <= 10} aria-label={`${remaining} seconds remaining`}>
      {remaining}s
    </span>
  </header>

  {#if receiver}
    <textarea
      class="secret-value"
      bind:this={valueElement}
      readonly
      rows="3"
      aria-label={`Value for ${item.label}`}
      value={revealed ? item.value : '••••••••••••'}
    ></textarea>

    <div class="secret-actions">
      <button class="button secondary" type="button" onclick={() => (revealed = !revealed)}>
        {revealed ? 'Hide' : 'Reveal'}
      </button>
      <button class="button secondary" type="button" onclick={copy}>Copy</button>
      <button class="button danger" type="button" {disabled} onclick={() => onRevoke(item.id)}>
        Revoke
      </button>
    </div>

    {#if copyFailed}
      <p class="error-note" role="alert">
        Clipboard access failed. Select the revealed value and copy it manually.
      </p>
    {/if}
  {:else}
    <div class="secret-actions">
      <button class="button danger" type="button" {disabled} onclick={() => onRevoke(item.id)}>
        Revoke
      </button>
    </div>
  {/if}
</article>

<style>
  .secret-card {
    border-top: 1px solid var(--border);
    padding: 1.125rem 0;
  }

  .secret-card:last-child {
    border-bottom: 1px solid var(--border);
  }

  .secret-card header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .secret-card strong {
    display: block;
    color: #1e293b;
    font-size: 0.875rem;
  }

  .secret-card small {
    display: block;
    margin-top: 0.2rem;
    color: var(--text-faint);
    font-size: 0.6875rem;
  }

  .secret-card header > span {
    border-radius: 999px;
    background: var(--surface-muted);
    padding: 0.25rem 0.5rem;
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.6875rem;
    font-weight: 700;
  }

  .secret-card header > span.expiring {
    background: #fff7ed;
    color: #c2410c;
  }

  .secret-value {
    min-height: 5.75rem;
    margin: 1rem 0 0;
    border-color: var(--border);
    background: #f8fafc;
    color: var(--text-strong);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.8125rem;
    resize: vertical;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .secret-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 1rem;
  }
</style>
