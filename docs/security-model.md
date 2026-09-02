# Security model

## Supported claim

The published browser client encrypts secret payloads before transmission. The Relay does not receive the room key, PIN, or plaintext. Payload encryption is HKDF-SHA-256 and AES-256-GCM through Web Crypto.

This is an end-to-end encrypted Relay, not a fully trustless service. A public web application must trust the server that supplies its JavaScript. A malicious operator or compromised application container can serve code that captures keys and plaintext. Published source, hashes, an SBOM, and container digests support auditing but cannot prove which code a first browser page received.

## Visible metadata and Relay powers

The Relay sees source address groups, connection times, room associations, ciphertext sizes, item expiration times, and protocol events. It can refuse, delay, drop, duplicate, reorder, or retain encrypted data and can lie about availability. Authentication detects header or ciphertext modification. Browser replay tracking and authenticated expiry reject duplicate and stale items. Software cannot force a malicious Relay to delete retained bytes.

No database, queue, object store, analytics, telemetry, cookie, local storage, IndexedDB, or service worker is used. Room state, rate data, encrypted pairing frames, and encrypted items exist in Relay memory. Logs contain aggregate events and errors, never room IDs, credentials, ciphertext, links, PINs, labels, values, or full addresses.

## Limits

Encrypted envelope version 1 has no application-layer forward secrecy. Someone who later obtains the pairing link, PIN, and retained traffic can recover session keys. The eight-character PIN has about 40 bits and captured pairing ciphertext permits offline guesses; separate channels and short room life bound but do not remove this risk.

Compromised endpoints, browser extensions, screen capture, shoulder surfing, clipboard residue, diagnostics, memory dumps, swap, and garbage-collector copies are outside the model. Clipboard data is deliberately not cleared because delayed clearing can overwrite newer content. JavaScript and `sessionStorage` provide no secure-erasure guarantee. Scanner or messaging applications may retain a pairing fragment.

Resource limits reduce casual abuse, not distributed denial of service. The production service relies on publicly trusted HTTPS/WSS through Caddy. It makes no third-party browser requests.
