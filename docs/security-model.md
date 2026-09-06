# Security model

## Supported claim

The published browser client encrypts secret payloads before transmission. The Relay does not receive the room key, PIN, private keys, chain keys, or plaintext. The client uses P-256 Elliptic Curve Diffie-Hellman (ECDH), HKDF-SHA-256, and AES-256-GCM through Web Crypto.

An ephemeral ECDH exchange protects a completed session if an attacker later obtains the pairing link, PIN, and retained traffic. Three symmetric ratchets delete processed message keys as they advance. Disclosure of a current chain key does not recover deleted keys for processed messages.

This is an end-to-end encrypted Relay, not a fully trustless service. A public web application must trust the server that supplies its JavaScript. A malicious operator or compromised application container can serve code that captures keys and plaintext. Published source, hashes, an SBOM, and container digests support auditing but cannot prove which code a first browser page received.

## Visible metadata and Relay powers

The Relay sees source address groups, connection times, room associations, ciphertext sizes, item expiration times, and protocol events. It can refuse, delay, drop, duplicate, reorder, or retain encrypted data and can lie about availability. Authentication detects header or ciphertext modification. Browser replay tracking and authenticated expiry reject duplicate and stale items. Software cannot force a malicious Relay to delete retained bytes.

No database, queue, object store, analytics, telemetry, cookie, local storage, IndexedDB, or service worker is used. Room state, rate data, encrypted pairing frames, and encrypted items exist in Relay memory. Logs contain aggregate events and errors, never room IDs, credentials, ciphertext, links, PINs, labels, values, or full addresses.

## Forward-security limits

Forward security applies after a browser authenticates a message, saves the next chain state, and deletes the processed logical key. The browser keeps keys for missing generations for at most five minutes. Those unprocessed messages remain exposed if an attacker obtains the skipped keys.

A current chain key exposes its current and future generations. KeyBridge does not provide post-compromise recovery. A compromise during pairing can expose the ephemeral Receiver private key in `sessionStorage`. P-256 is not resistant to a future cryptographically relevant quantum computer.

A reload keeps the paired session but does not restore processed items. Restoring those items would require KeyBridge to retain plaintext or deleted message keys. The browser shows only items that it processes after the reload.

The eight-character PIN has about 40 bits. Captured pairing ciphertext permits offline guesses. Separate channels and the short room lifetime limit exposure but do not prevent guessing.

## Endpoint limits

Compromised endpoints, browser extensions, screen capture, shoulder surfing, clipboard residue, diagnostics, memory dumps, swap, and garbage-collector copies are outside the model. Clipboard data is deliberately not cleared because delayed clearing can overwrite newer content. JavaScript and `sessionStorage` provide no secure-erasure guarantee. Scanner or messaging applications may retain a pairing fragment.

Resource limits reduce casual abuse, not distributed denial of service. The production service relies on publicly trusted HTTPS/WSS through Caddy. It makes no third-party browser requests.
