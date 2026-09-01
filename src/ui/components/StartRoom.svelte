<script lang="ts">
  export let onCreate: () => void;
  export let onSecurity: () => void;
</script>

<section class="landing">
  <div class="landing-copy">
    <p class="section-label">Private text transfer</p>
    <h1>Send a secret.<br /><em>Leave no trail.</em></h1>
    <p class="landing-summary">
      Pair a desktop with one phone, transfer encrypted text, and let the room expire.
    </p>
    <div class="landing-actions">
      <button class="button primary" onclick={onCreate}
        >Create room <span aria-hidden="true">→</span></button
      ><button class="button ghost" onclick={onSecurity}>Security &amp; transparency</button>
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
