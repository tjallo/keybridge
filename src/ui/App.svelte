<script lang="ts">
  import { onMount } from 'svelte';
  import ReceiverRoom from './components/ReceiverRoom.svelte';
  import SenderRoom from './components/SenderRoom.svelte';
  import StartRoom from './components/StartRoom.svelte';
  import { SessionController } from './session/controller';

  const controller = new SessionController();
  let snapshot = controller.snapshot;
  let releaseAssets: Record<string, string> = {};

  onMount(() => {
    const unsubscribe = controller.subscribe((value) => {
      snapshot = value;
    });

    void controller.start();
    void loadReleaseAssets();

    return () => {
      unsubscribe();
      controller.destroy();
    };
  });

  async function loadReleaseAssets(): Promise<void> {
    try {
      const response = await fetch('/release.json');
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as { assets?: unknown };
      if (isAssetMap(data.assets)) {
        releaseAssets = data.assets;
      }
    } catch {
      // Release details are supplementary. The room flow does not depend on this request.
    }
  }

  function isAssetMap(value: unknown): value is Record<string, string> {
    return (
      Boolean(value) &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((hash) => typeof hash === 'string')
    );
  }
</script>

<header class="site-header">
  <div class="site-nav">
    <button class="brand" type="button" onclick={() => controller.showStart()}>
      <span class="brand-mark" aria-hidden="true">K</span>
      <span>KeyBridge</span>
    </button>

    <nav aria-label="Project links">
      <a
        class="source-link"
        href="https://github.com/tjallo/keybridge"
        rel="noreferrer"
        target="_blank"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 1.2a6.8 6.8 0 0 0-2.15 13.25c.34.06.46-.14.46-.33v-1.2c-1.88.4-2.28-.8-2.28-.8-.3-.78-.76-.99-.76-.99-.62-.42.05-.41.05-.41.68.05 1.04.7 1.04.7.62 1.03 1.6.73 2 .56.06-.43.24-.73.44-.9-1.5-.16-3.08-.73-3.08-3.3 0-.73.27-1.33.7-1.8-.07-.17-.3-.86.07-1.78 0 0 .57-.18 1.86.69A6.5 6.5 0 0 1 8 4.9a6.5 6.5 0 0 1 1.7.23c1.3-.87 1.86-.69 1.86-.69.38.92.15 1.61.08 1.78.43.47.7 1.07.7 1.8 0 2.58-1.58 3.14-3.09 3.3.25.2.46.56.46 1.14v1.68c0 .19.12.4.47.33A6.8 6.8 0 0 0 8 1.2Z"
          ></path>
        </svg>
        <span>Source</span>
      </a>
      <span class="version">v{__APP_VERSION__}</span>
    </nav>
  </div>
</header>

<main class="page-shell">
  {#if snapshot.error}
    <div class="alert" role="alert">
      <span>{snapshot.error}</span>
      <button type="button" aria-label="Dismiss error" onclick={() => controller.dismissError()}>
        ×
      </button>
    </div>
  {/if}

  {#if snapshot.view === 'start'}
    <StartRoom
      onCreate={() => controller.createRoom()}
      onSecurity={() => controller.showSecurity()}
    />
  {:else if snapshot.view === 'sender'}
    <SenderRoom
      link={snapshot.link}
      pin={snapshot.pin}
      state={snapshot.roomState}
      connection={snapshot.connection}
      deadline={snapshot.deadline}
      items={snapshot.items}
      canApprove={snapshot.canApprove}
      onApprove={() => controller.approve()}
      onReject={() => controller.rejectPairing()}
      onSend={(label, value, ttl) => controller.sendItem(label, value, ttl)}
      onRevoke={(id) => controller.revoke(id)}
      onExtend={() => controller.extend()}
      onEnd={() => controller.end()}
    />
  {:else if snapshot.view === 'receiver'}
    <ReceiverRoom
      state={snapshot.receiverView}
      connection={snapshot.connection}
      items={snapshot.items}
      onSubmitPin={(pin) => controller.submitPin(pin)}
      onRevoke={(id) => controller.revoke(id)}
      onLeave={() => controller.leave()}
    />
  {:else}
    <section class="security-page">
      <p class="section-label">Security</p>
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
        The encrypted envelope has no forward secrecy. Clipboard content is not cleared. Browser
        memory and storage cannot guarantee secure erasure.
      </p>
      <div class="build-details">
        Transport 2 · Envelope 1 · Version {__APP_VERSION__} · Source {__SOURCE_COMMIT__}
      </div>
      <details>
        <summary>Client asset SHA-256 hashes</summary>
        {#each Object.entries(releaseAssets) as [asset, hash]}
          <code>{asset}: {hash}</code><br />
        {/each}
      </details>
      <button class="button secondary" type="button" onclick={() => controller.showStart()}>
        Back
      </button>
    </section>
  {/if}
</main>

<footer class="site-footer">
  <span>No accounts · No analytics · Session storage only</span>
  <a href="https://github.com/tjallo/keybridge" rel="noreferrer" target="_blank">
    View source on GitHub
  </a>
</footer>
