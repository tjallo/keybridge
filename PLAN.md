# KeyBridge v1 implementation plan

## Goal

KeyBridge transfers short-lived text secrets and files from one host to one Android client on a trusted local network.

The host runs an installed Node.js 26 command. One Svelte 5 web application serves the host dashboard and client page. The process keeps session state in memory and exits when the session ends.

## Confirmed product decisions

| Area | v1 decision |
| --- | --- |
| Client | A current Chromium-based browser on Android |
| Host | Linux, macOS, or Windows with Node.js 26 |
| Startup | Run the installed `keybridge` command and open the default browser |
| Transport | One HTTPS and WebSocket Secure listener on a random port |
| Certificate | Generate a self-signed certificate in memory for each launch |
| Pairing | Use a QR capability or an eight-character manual PIN |
| Approval | Require host approval and a matching short code |
| Client limit | Permit one pending or paired client |
| Reconnect | Reserve the client slot for 60 seconds |
| Session | End after 10 minutes of inactivity |
| Session refresh | Reset the timer after **Send** or **Extend** |
| Text | Send immutable labeled UTF-8 text |
| Files | Relay opaque files up to 1 GiB without disk storage |
| Item TTL | Use 60 seconds by default and start at **Send** |
| Client display | Hide text values until **Reveal** or **Copy** |
| Persistence | Store only the reconnect token in client `sessionStorage` |

The session timer pauses while file bytes make progress. A file transfer has a 30-second stall limit and a 15-minute total limit.

## V1 exclusions

V1 does not include these features:

- more than one client;
- client-to-host transfer;
- accounts, cloud services, or an internet relay;
- service discovery or multicast DNS;
- a persistent vault or transfer history;
- bulk import and export;
- a Progressive Web App or background service;
- file previews, archive extraction, or content execution;
- HTTP range requests or partial file resume;
- custom payload cryptography.

## Security model

### Trusted components

V1 trusts the host, the Android device, their browsers, and the local network. V1 excludes malicious local participants, Address Resolution Protocol spoofing, active local interception, and a compromised router.

The temporary self-signed certificate encrypts HTTPS and WebSocket traffic after each browser accepts the warning. The certificate does not authenticate the host. An active attacker can present another certificate and the same warning.

The user must accept a certificate warning on both the host and Android browser. Managed Android devices can block this action. The release test matrix must confirm the exact Chrome flow.

### Protections inside the threat model

KeyBridge limits accidental exposure with these controls:

- The operating system assigns a new port at each launch.
- The QR code contains a 256-bit, one-use pairing token.
- The URL stores the token in its fragment, not in the HTTP request target.
- The client removes the fragment from browser history after page startup.
- The host approves the first pending client.
- Both screens show the same short confirmation code.
- Pairing credentials expire and rotate after two minutes.
- A consumed credential cannot create another pending client.
- A new process creates new pairing and reconnect credentials.
- The server enforces item, transfer, frame, and active-list limits.
- The server sends cache prevention and content security headers.
- The server rejects host controls from non-loopback connections.
- The server rejects unexpected WebSocket origins and HTTP host names.

The random port reduces accidental reuse. The port does not provide authentication.

### Residual exposure

KeyBridge cannot remove these copies:

- text that the user copied to the Android clipboard;
- a file that Chrome downloaded or partly downloaded;
- screenshots, camera images, browser diagnostics, or operating-system dumps;
- copies retained by JavaScript engines, TLS libraries, or garbage collection;
- a scanned QR URL retained by an external camera application.

Expiration and revocation control the KeyBridge copy only. The client must show this fact before a file download.

## Architecture

One Node.js process owns all server state. The process uses one HTTPS listener on an operating-system assigned port.

The listener binds to IPv4 wildcard. The host opens the dashboard through the loopback address. The QR code uses one selected LAN IPv4 address.

The server has five direct responsibilities:

1. Serve the two built Svelte applications.
2. Handle the host and client WebSocket connections.
3. Own the session state machine and its timers.
4. Relay one file stream between the host and client.
5. Shut down and release all state.

The Svelte applications do not use a global state library. Each application owns one connection module and one top-level state object.

### Server modules

- `cli.ts` parses arguments, starts the server, opens the browser, and handles signals.
- `certificate.ts` creates the in-memory key and certificate.
- `network.ts` finds LAN addresses and validates address selection.
- `app-server.ts` creates the HTTPS server and dispatches HTTP routes.
- `websockets.ts` validates upgrades, frames, origins, and connection roles.
- `protocol.ts` defines message types, limits, and direct validators.
- `session.ts` implements all session and item transitions.
- `file-relay.ts` pairs upload and download streams and enforces transfer limits.
- `security.ts` applies headers, loopback checks, host checks, and redacted errors.

`session.ts` must not own sockets or HTTP objects. Its methods accept an action and a server timestamp. Each method returns a typed result for the transport code.

This boundary keeps state transitions testable without a framework or a generic event system.

## HTTPS and local networking

### Listener startup

1. Read the active network interfaces.
2. Keep non-loopback IPv4 addresses.
3. Prefer private IPv4 addresses in the dashboard list.
4. Generate a certificate for loopback and all detected addresses.
5. Listen on port `0` to request an operating-system assigned port.
6. Open the host URL through the loopback address.
7. Show a selector if the host has more than one LAN address.

The certificate uses a short validity period with clock-skew allowance. The private key and certificate remain in process memory.

An address change in the dashboard rotates the QR token and PIN. The server disables address changes while a pair request is pending or a client is paired.

A network change after startup requires a process restart. V1 does not monitor interface changes.

### Route separation

The server uses one port but separates privileges by route and source:

- `/host` and host assets require a loopback peer.
- `/ws/host` requires a loopback peer and the exact host origin.
- `/` and client assets allow a selected LAN origin.
- `/ws/client` requires an allowed client origin.
- Host upload routes require loopback, the host origin, and a one-use transfer token.
- Client download routes require a one-use transfer token.

The server validates the `Host` and `Origin` headers before it upgrades a WebSocket. This check reduces cross-site WebSocket and Domain Name System rebinding risks.

The server sends `Cache-Control: no-store` for HTML, JavaScript, application programming interface responses, and file responses. It also sends a strict Content Security Policy, `Referrer-Policy: no-referrer`, and MIME-sniffing protection.

### Local network failures

The dashboard must explain these common connection failures:

- The phone and host use different networks.
- The access point isolates wireless clients.
- A host firewall blocks the Node.js process.
- The QR code contains the wrong adapter address.
- Chrome policy blocks the certificate exception.

KeyBridge does not fall back to plaintext HTTP.

## Pairing design

### Credentials

The server creates two alternative credentials:

- a 32-byte random QR token encoded with Base64 URL syntax;
- an eight-character PIN in `XXXX-XXXX` form.

The PIN alphabet contains uppercase letters and digits without `0`, `1`, `I`, `L`, or `O`. A PIN has about 40 bits of entropy.

The host dashboard shows the manual client address next to the PIN. The QR code contains the selected HTTPS origin and the token in the URL fragment.

Both credentials expire after two minutes. The server rotates both credentials after expiry, manual rotation, rejection, or a failed pending request.

The server permits five invalid PIN attempts per credential set. The fifth failure rotates both credentials. QR token comparison uses a constant-time byte comparison after strict decoding.

### Approval flow

1. The client loads the HTTPS page and accepts the certificate warning.
2. The client reads the QR token from the fragment.
3. The client removes the fragment with `history.replaceState`.
4. The client opens the client WebSocket.
5. The client sends the QR token or manual PIN in its first message.
6. The server consumes both pairing credentials after the first valid request.
7. The server reserves the only client slot for 60 seconds.
8. The server sends a six-character matching code to both screens.
9. The host compares the code and selects **Approve** or **Reject**.
10. The server issues a 32-byte reconnect token after approval.

A second request receives a generic busy response while the first request is pending. A rejected, disconnected, or expired pending request returns the session to the unpaired state with new credentials.

The browser summary and network address are display hints. The server does not treat them as identity.

## Session state machine

The session uses these states:

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `STARTING` | The server creates the certificate and listener. | `UNPAIRED`, `ENDING` |
| `UNPAIRED` | Current QR and PIN credentials can accept one request. | `PAIR_PENDING`, `ENDING` |
| `PAIR_PENDING` | One client holds the pending slot. | `PAIRED`, `UNPAIRED`, `ENDING` |
| `PAIRED` | One approved client WebSocket is active. | `CLIENT_GRACE`, `UNPAIRED`, `ENDING` |
| `CLIENT_GRACE` | The approved client can resume for 60 seconds. | `PAIRED`, `UNPAIRED`, `ENDING` |
| `ENDING` | The server revokes state and closes connections. | `ENDED` |
| `ENDED` | The process has released the listener. | None |

The host connection has a separate 60-second grace timer. An active file source stream counts as host presence. An active file download counts as client presence.

The server rejects a concurrent WebSocket that presents the active reconnect token. A page reload can retry after the old socket closes. The server does not let a second tab replace an active connection.

If the client grace period expires, the server performs these actions:

1. Revoke all active items.
2. Invalidate the reconnect token.
3. Create new pairing credentials.
4. Return to `UNPAIRED` if the session remains active.

If the host grace period expires, the server ends the full session.

### Session deadline

The session starts with a 10-minute inactivity deadline. A successful text send, file offer, or explicit **Extend** action resets the deadline to 10 minutes.

Pairing, approval, reveal, copy, download selection, and WebSocket traffic do not reset this deadline. Byte progress during a file transfer pauses the deadline. The server resumes the saved time after the transfer ends or fails.

The process ends after the deadline, an explicit **End**, a termination signal, or an unrecoverable internal error. The server sends a final state event before it closes the sockets and listener.

## Item lifecycle

### Common item rules

Each item contains:

- a server-generated 128-bit identifier;
- a host request identifier for idempotency;
- a label with a fixed length limit;
- a kind of `text` or `file`;
- a creation time and server-owned expiration time;
- an immutable value or immutable file metadata;
- a state of `ACTIVE`, `TRANSFERRING`, or `REVOKED`.

The active list contains at most 10 items. The host can select 30, 60, 120, or 300 seconds. The default is 60 seconds.

The server starts the item TTL after it accepts **Send**. The server does not extend the TTL after reveal, copy, reconnect, or retry.

The host or client can revoke an item. Expiry, unpairing, and session shutdown also revoke items.

### Text items

A text item contains at most 64 KiB of UTF-8 data. The label has an 80-character limit.

The server keeps the value in memory until revocation. The client keeps the value in memory while its card remains active. A reconnect receives each unexpired text value with its original expiration time.

The host clears the text input after the server acknowledges the item. The client card starts hidden. **Reveal** does not affect the TTL.

The **Copy** action follows this order:

1. Try `navigator.clipboard.writeText()` from the user action.
2. Select the text if the Clipboard API fails or is unavailable.
3. Show an instruction for the Android copy action.

KeyBridge does not copy without a user action. KeyBridge does not clear the clipboard because a delayed clear can overwrite newer user content.

### File offers

A file offer contains a sanitized base filename and a declared size. The size limit is 1 GiB. KeyBridge ignores the browser-provided MIME type and serves `application/octet-stream`.

The host page keeps the selected `File` object. The Node process keeps metadata only. The host page removes its `File` reference after revocation or completed transfer.

A host page instance has an in-memory identifier. A WebSocket reconnect from the same page can retain file offers. A browser reload creates another identifier, so the server revokes all file offers from the old page.

The client receives file metadata through the WebSocket. The client receives no file bytes before **Download**.

### File relay

The server permits one file transfer at a time.

1. The client requests an active file through the WebSocket.
2. The server pauses the item and session deadlines.
3. The server creates separate one-use upload and download capabilities.
4. The server sends the upload capability to the host page.
5. The server sends the download capability to the client page.
6. The host posts the selected `File` to the upload route.
7. Chrome opens the download route as a normal browser download.
8. Node pipes the request stream to the response with backpressure.
9. The server counts bytes and sends throttled progress events.
10. The server revokes the item after it sends the declared byte count.

Both HTTP streams must start within 15 seconds. A transfer stops after 30 seconds without byte progress. A transfer also stops 15 minutes after the first attempt starts.

A completed HTTP response means Node sent all bytes. It does not prove that Chrome saved the file.

If a connection fails before completion, the server restores the item's saved TTL. The client can retry from byte zero until the item or transfer deadline expires. The server does not support range requests.

The server aborts both streams on a size mismatch, timeout, revocation, session end, or transport error. A partial Chrome download remains outside KeyBridge control.

## WebSocket protocol

All control messages and text values use bounded JSON text frames. File bytes use HTTPS streams.

Each message contains a protocol version and a message type. Mutation commands contain a request identifier. The server treats a repeated request identifier as the same command for the session.

The protocol has these command groups:

- pairing request, pending state, approval, rejection, and expiry;
- client resume, snapshot, disconnect, and leave;
- text send and file offer;
- item creation, expiry, revocation, and removal;
- file request, stream readiness, progress, failure, and completion;
- session extension, countdown, end, and error.

The first client message must be a pairing request or resume request. The server rejects all item commands before approval.

The server validates every message at runtime with small direct validators. The implementation does not add a schema framework.

The WebSocket server sets a frame limit above the 64 KiB text limit and below 128 KiB. It closes malformed, oversized, out-of-state, and unsupported-version connections with stable error codes.

A ping and pong heartbeat detects dead sockets. The heartbeat interval must leave enough time for Android background transitions before the 60-second reconnect grace starts.

## User experience

### Host dashboard

The host dashboard contains these sections:

- session status, inactivity countdown, **Extend**, and **End**;
- LAN address selector and certificate instructions;
- QR code, manual address, PIN, and credential countdown;
- pending-client code with **Approve** and **Reject**;
- text and file send controls with TTL presets;
- active items with countdown, transfer progress, and **Revoke**.

The dashboard disables **Send** unless the approved client has an active connection. The dashboard clears secret form values after a successful send.

The dashboard keeps QR and PIN values out of terminal logs. If browser startup fails, the CLI prints the loopback host address only.

### Android client

The client page contains these states:

- pairing credential input;
- pending approval with the matching code;
- connected item list and session countdown;
- reconnecting state with the grace countdown;
- ended or expired state.

Text cards start hidden. File cards show the filename, size, TTL, and persistence warning. The page requires a second user action to start a download after it shows the warning.

The page stores the reconnect token in `sessionStorage`. It stores no text value, file byte, PIN, or QR token there. The page clears the token after unpairing or session end.

## Memory and persistence

The process does not create a database, temporary secret file, transfer log, or telemetry event.

The server removes references to text values after revocation. The server overwrites owned byte buffers when the operation does not create another copy. JavaScript strings and runtime copies cannot receive a reliable zeroization guarantee.

The file relay uses bounded stream buffers. It does not retain the complete file. The operating system and TLS implementation can retain temporary memory pages outside application control.

Every application response uses cache prevention headers. Input controls disable autocomplete, spellcheck, and automatic capitalization where browsers honor those attributes.

The generated certificate key remains in memory. The process drops its reference at shutdown. KeyBridge does not claim secure key erasure from managed runtime memory.

## Dependencies

Use Node.js standard modules for HTTPS, cryptographic randomness, streams, timers, network interfaces, argument parsing, and process control.

Add these focused dependencies:

- `ws` for the WebSocket server;
- `selfsigned` for in-memory X.509 certificate generation;
- `qrcode-generator` for the QR matrix;
- Svelte 5 and Vite for the two browser bundles.

Use TypeScript in strict mode. Use the Node.js test runner for server tests. Use Playwright for browser flows and Android viewport emulation.

Do not add Express, a database client, a state library, a logging framework, a dependency injection container, a runtime schema framework, or a payload cryptography package.

Commit the package lock. Pin major versions and review transitive packages before the first release.

## Repository structure

```text
.
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── src
│   ├── cli.ts
│   ├── server
│   │   ├── app-server.ts
│   │   ├── certificate.ts
│   │   ├── file-relay.ts
│   │   ├── network.ts
│   │   ├── protocol.ts
│   │   ├── security.ts
│   │   ├── session.ts
│   │   └── websockets.ts
│   └── ui
│       ├── client
│       │   ├── App.svelte
│       │   ├── ItemCard.svelte
│       │   └── main.ts
│       ├── host
│       │   ├── App.svelte
│       │   ├── ActiveItems.svelte
│       │   ├── PairingPanel.svelte
│       │   ├── SendPanel.svelte
│       │   └── main.ts
│       └── shared.css
├── test
│   ├── certificate.test.ts
│   ├── file-relay.test.ts
│   ├── network.test.ts
│   ├── protocol.test.ts
│   ├── session.test.ts
│   └── integration
├── e2e
├── docs
│   └── protocol.md
└── README.md
```

Create a component only when it owns a distinct form or item behavior. Keep state transitions in `session.ts`, not in Svelte components.

## Error handling

The protocol uses stable public error codes such as `busy`, `expired`, `invalid_message`, `not_allowed`, `too_large`, and `transfer_unavailable`.

Expected user errors do not include stack traces. Server logs can contain timestamps, state names, item identifiers, and byte counts. Logs must exclude values, filenames when avoidable, credentials, transfer URLs, and reconnect tokens.

A transport error revokes the affected transfer. A state invariant failure ends the session instead of continuing with uncertain authorization state.

The CLI handles interrupt and termination signals. Shutdown revokes state, aborts streams, closes sockets, closes the listener, and exits.

## Testing strategy

### Unit tests

Test the session state machine with explicit timestamps:

- first-request slot reservation;
- approval, rejection, and pending timeout;
- credential rotation and invalid PIN limits;
- QR, PIN, reconnect, and request replay;
- concurrent client rejection;
- reconnect success and grace expiry;
- session refresh from **Send** and **Extend** only;
- item expiry, revoke, and reconnect snapshots;
- file timer pause, retry, stall, and hard timeout;
- host page reload revocation for file offers;
- process shutdown from each session state.

Test protocol and HTTP boundaries:

- malformed JSON and unknown fields;
- oversized frames, labels, text, and files;
- invalid host names and origins;
- non-loopback host requests;
- filename and response-header injection;
- transfer token reuse and wrong-item access;
- upload size mismatch and client abort;
- secret and token redaction from errors.

### Integration tests

Start the HTTPS server on port `0` with certificate verification disabled in the test client.

Exercise these paths with real HTTPS and WebSocket connections:

- QR pairing and manual PIN pairing;
- two clients that race for the pending slot;
- page reload and reconnect token recovery;
- text send, expiry, revoke, and resync;
- streamed file delivery with a slow reader;
- interrupted file delivery and full retry;
- transfer completion and capability invalidation;
- host disconnect and session shutdown;
- process restart and stale-token rejection.

Use generated bytes and a test hash to confirm stream integrity. Do not place fixture secrets in the repository.

### Browser tests

Use Playwright with the HTTPS warning disabled in the harness. Test the host page and an Android Chromium viewport.

Cover these user flows:

- fragment removal after QR startup;
- matching-code approval;
- hidden text, reveal, copy failure, and manual selection;
- client reload during reconnect grace;
- second-tab rejection;
- item countdown and removal;
- file warning, download, progress, and completed revocation;
- session extension and session end;
- cache and security response headers.

### Manual platform tests

Test the packaged CLI on Linux, macOS, and Windows. Test a physical Android device with the current Chrome release.

The manual checklist must include:

- certificate warning steps on host and Android;
- offline LAN use without an internet route;
- host firewall prompts;
- multiple adapters and a VPN adapter;
- Wi-Fi client isolation failure text;
- Android sleep, reload, and reconnect behavior;
- a 1 GiB transfer, cancellation, retry, and insufficient storage;
- browser history, clipboard, partial downloads, and completed downloads;
- process exit with no secret file created.

## Incremental implementation phases

### Phase 1: Build and HTTPS shell

- Create the Node.js, TypeScript, Svelte, and Vite setup.
- Generate an in-memory certificate with all required address entries.
- Start one HTTPS listener on an assigned port.
- Serve separate host and client bundles.
- Add route, origin, loopback, header, and request-size checks.
- Open the host browser and print a fallback host address.

Exit criterion: Both pages load on a LAN, and route-boundary tests pass.

### Phase 2: Pairing and session state

- Implement `session.ts` with explicit transitions and timestamps.
- Add QR and PIN rotation.
- Add the pending slot, matching code, approval, and rejection.
- Enforce one client and reconnect grace.
- Add session inactivity, host grace, and clean process exit.

Exit criterion: Unit and integration tests cover each session transition and race.

### Phase 3: Text transfer

- Add immutable text commands and active-list limits.
- Add TTL presets, expiry, revoke, and reconnect snapshots.
- Add hidden client cards and best-effort copy.
- Clear host inputs and client values at the correct lifecycle points.

Exit criterion: Browser tests cover send, reveal, copy fallback, expiry, revoke, and reload.

### Phase 4: Live file relay

- Add file offers and host page instance tracking.
- Add one-use upload and download capabilities.
- Pipe one file with backpressure and byte validation.
- Add progress, timer pause, stall handling, full retry, and completion revoke.
- Add the Android persistence warning and normal browser download.

Exit criterion: Integration tests stream 1 GiB without whole-file server buffering and cover abort paths.

### Phase 5: Hardening and packaging

- Add heartbeat handling and bounded public errors.
- Audit logs and memory references.
- Add signal handling and fatal-invariant shutdown.
- Build the npm executable and include the browser assets.
- Add README operation steps, limitations, and troubleshooting.
- Add the protocol state table to `docs/protocol.md`.

Exit criterion: Type checks, tests, production build, and package inspection pass.

### Phase 6: Platform verification

- Run the manual checklist on each host operating system.
- Run the Android Chrome pairing and file tests on a physical device.
- Record unsupported browser and managed-device behavior.
- Fix platform failures before the first release.

Exit criterion: The package completes one text transfer and one large-file transfer on each supported host.

## Planned verification commands

The implementation should provide these commands:

```text
npm run format:check
npm run check
npm test
npm run test:integration
npm run test:e2e
npm run build
npm pack --dry-run
```

The repository is empty, so these commands do not exist yet. Each implementation phase must add and run its applicable checks.

## Acceptance criteria

V1 is ready when all these statements are true:

- One command starts one temporary session and opens the host dashboard.
- The host and Android browser can pass their certificate warnings and connect over the LAN.
- A QR scan or manual PIN creates one pending client.
- A second client cannot become pending, paired, or reconnected.
- The host verifies a matching code before any secret reaches the client.
- Text expires and disappears from both application views.
- The same client can recover unexpired text during the 60-second grace period.
- A large file streams without a database, temporary file, or whole-file server buffer.
- A successful file response revokes the file offer.
- A failed file transfer permits a byte-zero retry within the remaining deadlines.
- Session end invalidates all capabilities and exits the process.
- Logs, caches, and browser storage contain no KeyBridge secret values by design.
- Documentation states that clipboard and downloaded copies remain outside KeyBridge control.
