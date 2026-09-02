<script lang="ts">
  export let onCreate: () => void;
  export let onSecurity: () => void;
</script>

<section class="landing">
  <div class="landing-copy">
    <p class="section-label">Private text transfer</p>

    <h1>
      Send a secret.<br />
      <em>Leave no trail.</em>
    </h1>

    <p class="landing-summary">
      Pair a desktop with one phone, transfer encrypted text, and let the room expire.
    </p>

    <div class="landing-actions">
      <button class="button primary" type="button" onclick={onCreate}>
        Create room <span aria-hidden="true">→</span>
      </button>
      <button class="button ghost" type="button" onclick={onSecurity}>
        Security &amp; transparency
      </button>
    </div>
  </div>

  <aside class="flow-card" aria-label="How KeyBridge works">
    <div class="flow-step">
      <span>01</span>
      <div>
        <strong>Create a room</strong>
        <p>KeyBridge creates a temporary pairing link and PIN.</p>
      </div>
    </div>

    <div class="flow-step">
      <span>02</span>
      <div>
        <strong>Pair your phone</strong>
        <p>Scan the QR code and confirm the separate PIN.</p>
      </div>
    </div>

    <div class="flow-step">
      <span>03</span>
      <div>
        <strong>Transfer text</strong>
        <p>Approve the device, send the text, then end the room.</p>
      </div>
    </div>
  </aside>
</section>

<style>
  .landing {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(18rem, 0.9fr);
    align-items: center;
    gap: clamp(2.5rem, 7vw, 6rem);
    min-height: 31rem;
    max-width: 64rem;
    margin: 0 auto;
  }

  .landing h1 {
    max-width: 10ch;
    margin-bottom: 1.25rem;
    font-size: clamp(3rem, 7vw, 5.25rem);
    letter-spacing: -0.06em;
  }

  .landing h1 em {
    color: var(--accent);
    font-style: normal;
  }

  .landing-summary {
    max-width: 30rem;
    margin-bottom: 1.75rem;
    font-size: 1.0625rem;
  }

  .landing-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .flow-card {
    position: relative;
    border-left: 1px solid #dbe2ea;
    padding: 0.5rem 0 0.5rem 2rem;
  }

  .flow-card::before {
    position: absolute;
    top: -1.5rem;
    left: -1px;
    width: 1px;
    height: 1.5rem;
    background: var(--accent);
    content: '';
  }

  .flow-step {
    display: grid;
    grid-template-columns: 2.2rem 1fr;
    gap: 0.875rem;
    padding: 1rem 0;
  }

  .flow-step + .flow-step {
    border-top: 1px solid #edf1f5;
  }

  .flow-step > span {
    padding-top: 0.2rem;
    color: var(--text-faint);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.6875rem;
    font-weight: 700;
  }

  .flow-step strong {
    color: #1e293b;
    font-size: 0.875rem;
  }

  .flow-step p {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
  }

  @media (max-width: 700px) {
    .landing {
      grid-template-columns: 1fr;
      min-height: auto;
    }

    .landing h1 {
      font-size: clamp(2.8rem, 15vw, 4.25rem);
    }

    .flow-card {
      margin-top: 1rem;
    }
  }

  @media (max-width: 430px) {
    .landing-actions {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
