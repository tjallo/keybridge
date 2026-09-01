# KeyBridge v1 implementation plan

## Goal

KeyBridge transfers short-lived text secrets from a desktop sender to one phone receiver through a public relay.

The sender opens `keybridge.tjallo.nl`, creates a room, and shows a QR code. The phone scans the QR code, enters a separate PIN, and waits for sender approval. The sender can then send passwords, tokens, recovery codes, or configuration text.

The relay stores room state and ciphertext in memory. Browser code encrypts each secret before it reaches the relay.

## Product terms

Use these terms in code, the protocol, and the interface:

- **Sender:** The desktop browser that creates a room and sends secrets.
- **Receiver:** The phone browser that scans the QR code and receives secrets.
- **Relay:** The public Node.js service that connects both browsers.
- **Room:** One temporary sender and receiver session.
- **Pairing link:** The URL that contains a room identifier and room key in its fragment.
- **PIN:** The separate eight-character code shown by the sender.

Avoid the term **host** in protocol code. It can mean the sender computer, deployment server, or HTTP host name.

## Confirmed product decisions

| Area | v1 decision |
| --- | --- |
| Public address | `keybridge.tjallo.nl` |
| Sender | A current desktop browser |
| Receiver | A current Chromium-based browser on Android |
| Direction | Sender to receiver only |
| Access | Public, without accounts |
| Room limit | One receiver per room; many rooms per relay |
| Front end | Svelte 5 with Vite, without SvelteKit |
| Relay | Node.js 26 with WebSockets |
| Transport | Public HTTPS and WebSocket Secure through Caddy |
| Payload protection | Browser end-to-end encryption with Web Crypto |
| Pairing | QR or copied full link, separate PIN, then sender approval |
| Text | Immutable labeled UTF-8 text only |
| Files | Excluded |
| Item TTL | 60 seconds by default, starting when the sender sends |
| Room TTL | 10 minutes of inactivity |
| Reconnect | 60-second grace period |
| Persistence | Room keys and reconnect credentials in `sessionStorage` only |
| Development | Docker Compose first; no host Node.js installation required |
| Deployment | One application container behind the existing Caddy container |

## V1 exclusions

V1 does not include these features:

- file, image, directory, or binary transfer;
- receiver-to-sender secret transfer;
- bidirectional rooms;
- more than one receiver in a room;
- accounts, profiles, or contact lists;
- a persistent vault or transfer history;
- offline delivery or a message queue;
- bulk import and export;
- a Progressive Web App or background service;
- third-party analytics, scripts, fonts, or content delivery networks;
- custom transport security or a self-signed certificate;
- application-layer forward secrecy;
- multiple relay instances or shared room storage.

## Trust and security claims

### Supported claim

KeyBridge can make this bounded claim:

> The published browser client encrypts secret payloads before transmission. The relay does not receive the room key, PIN, or plaintext.

The relay sees metadata. This metadata includes network addresses, connection times, room associations, ciphertext sizes, item expiration times, and protocol events.

### Browser bootstrap limit

A public web application cannot remove trust in the server that supplies its JavaScript. A malicious operator or compromised application container can serve modified code that captures room keys and plaintext.

Open source and reproducible artifacts help users audit the application. They do not let a browser verify the first page against a hostile server.

KeyBridge must use **end-to-end encrypted relay** or **zero-knowledge payload relay** for this model. User-facing text must not claim full trustlessness or protection from a malicious code-serving server.

A separately installed and signed application or browser extension would reduce this bootstrap risk. V1 keeps zero-install browser access and accepts the risk.

### Relay powers

A malicious relay can perform these actions:

- refuse or delay connections;
- drop, duplicate, or reorder encrypted messages;
- retain ciphertext and metadata after expiry;
- lie about room availability;
- serve modified browser code if it also controls the application response.

Authenticated encryption detects ciphertext modification. Client-side message identifiers and expiration times detect stale replay. No browser protocol can force the relay to delete stored bytes.

### Endpoint limits

KeyBridge does not protect against these conditions:

- a compromised sender or receiver;
- a malicious browser extension;
- screen capture or shoulder surfing;
- copied clipboard content;
- a pairing link and PIN that leak together;
- browser diagnostics, memory dumps, swap, or garbage-collector copies.

## Public pairing design

### Room creation

The sender browser generates all pairing secrets with `crypto.getRandomValues()`:

- a 16-byte room identifier;
- a 32-byte room key;
- an eight-character PIN;
- sender connection and request identifiers.

The PIN uses uppercase letters and digits without `0`, `1`, `I`, `L`, or `O`. The sender displays the PIN as `XXXX-XXXX`.

The pairing link places the room identifier and room key in the URL fragment. Browsers do not send a URL fragment in the HTTP request target. The Svelte application removes the fragment with `history.replaceState()` after import.

The relay receives the room identifier through the WebSocket protocol. The relay never receives the room key or PIN.

### Separate link and PIN

The QR code and copied pairing link contain the same high-entropy capability. The PIN stays outside that link.

Users should send a copied link and PIN through separate channels when practical. A QR scan already provides a separate visual channel for the PIN.

The PIN contributes to browser key derivation. The phone does not send the PIN as plaintext or encrypted data. A correct PIN lets both browsers derive the same pairing key.

A party with the full pairing link can attempt offline PIN guesses against captured pairing ciphertext. The eight-character alphabet provides about 40 bits of PIN entropy. The short room lifetime and separate-link workflow limit this risk, but they do not remove it.

### Pairing flow

1. The sender creates a room.
2. The sender browser registers the random room identifier with the relay.
3. The sender displays the QR code, full link, and separate PIN.
4. The receiver opens the link and removes its fragment from history.
5. The receiver enters the PIN shown by the sender.
6. The receiver derives the pairing key in its browser.
7. The receiver sends an encrypted pairing request through the relay.
8. The relay reserves the room receiver slot for 60 seconds.
9. The sender decrypts the request with its locally derived pairing key.
10. The sender selects **Approve** or **Reject**.
11. The sender sends an encrypted approval response.
12. Both browsers derive directional session keys.

A wrong PIN produces an authentication failure in the sender browser. The relay sees a failed pending request but cannot distinguish a wrong PIN from malformed ciphertext.

The sender must approve each receiver after successful PIN verification. Pairing success does not send an existing secret until approval completes.

### Pairing contention

The first receiver connection reserves the pending slot. Later receivers receive a generic busy response.

A rejected, disconnected, or expired pending receiver releases the slot. The sender browser creates a new PIN after rejection. The sender can also end the room and create a new pairing link.

The relay limits pending attempts per room and source address. These limits reduce online guessing and denial of service. They do not provide account-grade abuse prevention.

## Browser cryptography

### Primitive selection

Use the browser Web Crypto API only:

- HKDF with SHA-256 for key derivation;
- AES-256-GCM for authenticated encryption;
- `crypto.getRandomValues()` for keys, identifiers, and 96-bit nonces.

Do not implement a cipher, hash, random generator, or Password-Authenticated Key Exchange protocol. Do not add a payload cryptography package in v1.

### Key derivation

The pairing key depends on these inputs:

- the 256-bit room key from the URL fragment;
- the room identifier;
- the normalized separate PIN;
- a protocol-specific HKDF information string.

PIN normalization removes the hyphen and accepts eight uppercase alphabet characters only. It does not apply locale-sensitive or Unicode normalization.

A successful pairing request contains a random receiver nonce inside its encrypted body. The approval response contains a random sender nonce.

Both browsers derive separate session keys from the pairing key and both nonces:

- a sender-to-receiver item key;
- a receiver-to-sender control key;
- a sender-to-receiver control key.

Separate directional keys prevent nonce reuse across roles. Protocol-specific HKDF information strings prevent key reuse between pairing, item, and control messages.

V1 does not use ephemeral Diffie-Hellman. If the pairing link and PIN leak later, a party that retained the handshake and ciphertext can derive the session keys. The security page must state this lack of forward secrecy.

### Encrypted envelope

Each encrypted envelope contains a bounded clear header:

- protocol version;
- room identifier;
- message identifier;
- direction;
- expiration time when applicable;
- 96-bit nonce;
- ciphertext and authentication tag.

The sender encodes the header as a fixed JSON tuple and supplies its UTF-8 bytes as AES-GCM additional authenticated data. The encrypted body duplicates security-relevant header fields. The receiver rejects a mismatch.

Each encryption operation uses a fresh random nonce. The room message cap keeps random nonce collision risk negligible. Each browser tracks processed message identifiers and rejects a duplicate.

The relay can read the header fields required for routing and expiry. The relay cannot alter those fields without causing authenticated decryption to fail.

### Plaintext item

An item plaintext contains:

- an item identifier;
- a label;
- a UTF-8 text value;
- a sender creation time;
- an expiration time;
- the selected TTL.

The sender treats each item as immutable. A correction requires revocation and a new item.

## Architecture

### Production request path

The production request path is:

```text
Browser HTTPS/WSS
        |
        v
Caddy on ports 80/443
        |
        v
KeyBridge container on internal HTTP port 3000
```

Caddy terminates publicly trusted TLS. Caddy proxies normal HTTP requests and WebSocket upgrades to the KeyBridge container through the existing Compose network.

The application container serves the built Svelte assets and owns the WebSocket relay. The container does not publish a host port in the homelab Compose file.

### Relay responsibilities

The Node.js relay has these direct responsibilities:

1. Serve the built Svelte application.
2. Create and expire in-memory rooms.
3. Enforce one sender and one receiver per room.
4. Relay bounded encrypted envelopes.
5. Retain unexpired item ciphertext for reconnect.
6. Apply connection, room, frame, and memory limits.
7. Shut down without writing room state.

The relay does not import browser plaintext types or browser key-derivation code. Shared protocol types expose encrypted envelopes and public metadata only.

### Svelte application

One Svelte application handles three views:

- landing and room creation;
- sender room controls;
- receiver pairing and item cards.

The application selects a view from in-memory role state and the imported URL fragment. V1 needs no application router.

Svelte components render labels and values as text. The application does not use `{@html}`, Markdown rendering, or user-supplied styles.

## Svelte framework decision

### Selected: Svelte 5 with Vite

Use `@sveltejs/vite-plugin-svelte` with a small manual Vite configuration.

Benefits:

- Vite produces static HTML, JavaScript, and CSS for the relay to serve.
- The application needs no server-side rendering.
- The room state lives in browser memory and WebSockets.
- One entry point supports all three views.
- The dependency and convention surface stays small.
- Vite supplies fast development builds and Hot Module Replacement.

Costs:

- KeyBridge must define its own small view-state model.
- A future multi-page documentation site would need routing or another build target.
- The project must configure response headers in the Node relay and Caddy.

### Alternative: SvelteKit with static output

SvelteKit static output would add filesystem routing, layouts, error pages, and prerendering. It would help if KeyBridge gained many public documentation or policy pages.

V1 has one application shell and no server-rendered data. SvelteKit would add routing conventions without reducing relay or cryptography code.

### Alternative: SvelteKit with adapter-node

`@sveltejs/adapter-node` builds a standalone Node server. Its generated handler can run inside a custom Node server.

KeyBridge would still need custom WebSocket upgrade handling, room state, limits, shutdown behavior, and proxy awareness. A custom server must also implement lifecycle settings that the default adapter server normally owns.

This option couples page serving and relay lifecycle to SvelteKit without a matching v1 benefit.

### Bootstrap approach

Do not run `npx sv create` because it creates a SvelteKit project. Do not require `npm create vite` on the host.

Create the small Vite setup directly in the repository:

- `package.json`;
- `vite.config.ts`;
- `index.html`;
- TypeScript configuration;
- `src/ui/main.ts`;
- `src/ui/App.svelte`.

Docker installs and runs all JavaScript dependencies. A developer needs Git and Docker with Compose, but does not need Node.js or npm on the host.

## Room state machine

Each room uses these states:

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `WAITING` | The sender is connected and the room can accept one receiver. | `PAIR_PENDING`, `SENDER_GRACE`, `ENDED` |
| `PAIR_PENDING` | One receiver holds the pending slot. | `PAIRED`, `WAITING`, `SENDER_GRACE`, `ENDED` |
| `PAIRED` | The sender and approved receiver are connected. | `RECEIVER_GRACE`, `SENDER_GRACE`, `ENDED` |
| `RECEIVER_GRACE` | The approved receiver can reconnect for 60 seconds. | `PAIRED`, `SENDER_GRACE`, `ENDED` |
| `SENDER_GRACE` | The sender can reconnect for 60 seconds. | Prior active state, `ENDED` |
| `ENDED` | The relay has removed the room and ciphertext. | None |

The sender WebSocket creates the room. The relay returns a random sender reconnect credential. The receiver receives a separate reconnect credential after approval.

The relay rejects a concurrent connection that presents an active role credential. A page reload can retry after the old socket closes.

If the sender grace period expires, the relay ends the room. If the receiver grace period expires, the relay revokes all active items and returns the room to `WAITING` with a new PIN in the sender browser.

### Room deadline

A room starts with a 10-minute inactivity deadline. A successful item send or sender **Extend** action resets the deadline to 10 minutes.

Pairing traffic, WebSocket heartbeats, reveal, copy, and ordinary page activity do not reset the deadline.

The relay ends a room after its deadline, sender action, sender grace expiry, or server shutdown. Room end invalidates all relay credentials and removes all retained ciphertext.

## Secret lifecycle

### Limits

Each room has these limits:

- 10 active items;
- 64 KiB maximum plaintext per item in the sender browser;
- 72 KiB maximum encrypted envelope at the relay;
- 256 KiB maximum retained ciphertext per room;
- TTL choices of 30, 60, 120, or 300 seconds.

The default TTL is 60 seconds. The sender browser enforces the plaintext limit before encryption. The relay enforces the ciphertext limits.

### Send

1. The sender enters a label and text value.
2. The sender selects a TTL or keeps 60 seconds.
3. The sender browser creates the immutable item plaintext.
4. The sender browser encrypts the item.
5. The relay validates the clear envelope and stores the ciphertext.
6. The relay forwards the envelope to the receiver.
7. The receiver decrypts and validates the duplicated header fields.
8. Both browsers show the same authenticated expiration countdown.
9. The sender clears its input after relay acknowledgement.

The sender cannot send before receiver approval or during receiver grace.

### Expiry and revocation

The relay removes ciphertext at expiry. Both browsers also enforce the authenticated expiration time from the encrypted item.

The sender or receiver can revoke an item. The relay makes revoke commands idempotent and removes the stored envelope.

A malicious relay can retain ciphertext despite the command. It cannot decrypt the ciphertext without the pairing link and PIN under the published client design.

### Receiver display and clipboard

A receiver card starts hidden. The card shows the label, type, and expiration countdown.

**Reveal** does not change the TTL. **Copy** uses `navigator.clipboard.writeText()` from a user action. The application selects the value and shows a manual-copy instruction if the Clipboard API fails.

KeyBridge does not clear the clipboard. A delayed clear can overwrite content that the user copied later.

### Reconnect

The relay resends unexpired encrypted item envelopes after the approved receiver reconnects. The original authenticated expiration times remain in effect.

The receiver stores the room key, derived session state, and relay reconnect credential in `sessionStorage`. It stores no decrypted item value there.

The sender stores equivalent room and reconnect state in `sessionStorage`. A tab reload can restore the room. A closed browser session can lose the room.

Both browsers clear room key material and relay credentials after room end. JavaScript and browser storage do not provide a secure erasure guarantee.

## WebSocket protocol

The browser and relay exchange bounded JSON text frames. Binary and file frames are unsupported.

Each frame contains a protocol version and message type. Mutation commands contain a random request identifier for idempotency.

The protocol has these command groups:

- sender room creation, resume, extend, and end;
- receiver join, pairing request, approval, rejection, resume, and leave;
- encrypted item send, snapshot, revoke, and expiry;
- room state, countdown, and public errors;
- heartbeat and connection close.

The first sender message must create or resume a room. The first receiver message must join or resume a room.

The relay validates messages with small direct functions. The project does not add a runtime schema framework.

The `ws` server enforces a frame limit below 96 KiB. It closes malformed, oversized, unsupported-version, and out-of-state connections with stable error codes.

The WebSocket heartbeat detects dead sockets. Heartbeat failure starts the applicable reconnect grace period.

## Public abuse controls

A public encrypted relay cannot inspect content. V1 uses resource limits instead of content moderation.

Initial limits:

- 5 live rooms per IPv4 address or IPv6 `/64` prefix;
- 20 room creations per address group in 10 minutes;
- 20 WebSocket connections per address group;
- 500 live rooms for one relay process;
- 128 MiB of retained ciphertext for the full process;
- 256 KiB of retained ciphertext per room;
- one pending receiver per room;
- bounded pending attempts and malformed frames;
- a 10-minute room deadline and short item TTLs.

The relay returns `busy` when a global limit is full. It returns `rate_limited` for an address limit. Public errors do not reveal whether a random room identifier exists.

All limit state remains in memory. A process restart resets rate counters and ends rooms.

Caddy is the only network peer that can reach the relay in production. The relay accepts forwarding headers only from that deployment path. It normalizes source addresses before applying limits.

These controls reduce casual abuse and memory exhaustion. They do not stop a distributed denial-of-service attack. V1 does not add CAPTCHAs, accounts, or an external rate-limit service.

## Privacy and transparency

### Data handling

The application uses no database, object storage, queue, analytics service, or telemetry service.

The relay logs aggregate state changes and errors. Logs exclude these values:

- room identifiers;
- reconnect credentials;
- ciphertext;
- pairing links and fragments;
- PIN values;
- labels and secret values;
- full network addresses.

In-memory address data exists for rate limiting. The relay removes it when its rate window expires.

The current Caddy configuration does not enable an access log. The KeyBridge route should not add one. Caddy error logs must not include WebSocket frame content.

### Browser storage and caching

The HTML response uses revalidation or `no-store`. Content-hashed JavaScript and CSS can use immutable caching because they contain no room data.

KeyBridge uses no cookie, local storage, IndexedDB database, or service worker. Each browser uses `sessionStorage` for temporary room and reconnect state.

The QR fragment can remain in an external scanner or messaging application. Pairing links expire with their room, but retained links still expose the room key.

### Transparent release information

Each production build embeds these public values:

- a semantic version;
- a source commit identifier;
- a client asset manifest with SHA-256 hashes;
- a protocol version.

The interface exposes this information on a security page. The release process publishes the source, package lock, container digest, software bill of materials, and build checksums.

A release must not claim reproducible builds until two clean builds produce matching artifacts. The public site cannot prove that it serves the published image, so the security page must retain the browser bootstrap warning.

KeyBridge includes no third-party browser requests. A user can inspect the network panel and see only the KeyBridge origin.

## HTTP and browser security

Caddy and the relay apply these controls:

- strict Content Security Policy with scripts, styles, images, and connections limited to the KeyBridge origin;
- `frame-ancestors 'none'` and frame protection;
- `object-src 'none'` and `base-uri 'none'`;
- strict transport security;
- `Referrer-Policy: no-referrer`;
- MIME-sniffing protection;
- same-origin opener and resource policies;
- a Permissions Policy that disables unused sensors and media APIs.

The application does not need camera permission. Android scans the QR code with its system camera application.

The relay checks the exact public `Origin` for WebSocket upgrades. It rejects cross-origin browser connections.

## Docker-first development

### Developer prerequisite

A developer installs Docker with the Compose plugin. The developer does not install Node.js, npm, Svelte, Vite, or Playwright on the host.

### Development containers

Use one development image with Node.js 26 and installed package dependencies. Compose starts two development services from that image:

- `web` runs the Vite development server with Hot Module Replacement;
- `relay` runs the Node relay in watch mode.

An on-demand `e2e` service uses the browser-test image stage with Chromium installed.

Vite proxies the WebSocket path to `relay:3000`. The host browser connects to Vite on a published loopback development port.

Both services mount the source tree. A named volume holds container `node_modules` so the bind mount does not create host dependencies.

The standard development command is:

```text
docker compose -f compose.dev.yaml up --build
```

Run checks through one-off containers:

```text
docker compose -f compose.dev.yaml run --rm relay npm run check
docker compose -f compose.dev.yaml run --rm relay npm test
docker compose -f compose.dev.yaml run --rm e2e npm run test:e2e
```

The development server can use the secure-context exception for desktop loopback. Test a physical Android phone through a Caddy-backed staging or production origin.

### Docker files

- `Dockerfile` contains dependency, build, development, browser-test, and runtime stages.
- `compose.dev.yaml` contains bind mounts, Vite, relay watch mode, and test commands.
- The browser-test stage installs Chromium and its system libraries inside the image.
- `compose.yaml` provides a production-like local container for smoke tests.
- `.dockerignore` excludes Git data, local build output, logs, and browser test artifacts.

The dependency stage uses `npm ci` and the committed package lock. The runtime stage copies built assets and production dependencies only.

### Runtime container

The runtime image:

- uses a pinned Node.js 26 base image;
- runs as a non-root user;
- uses an exec-form command for signal handling;
- writes no application data;
- supports a read-only root filesystem;
- uses a temporary in-memory directory when Node requires one;
- listens on `0.0.0.0:3000` inside the Compose network;
- exposes a minimal health endpoint without room statistics.

The Compose service drops Linux capabilities, enables `no-new-privileges`, uses no persistent volume, and does not publish port 3000 on the homelab host.

## Homelab deployment

The existing Caddy image already includes the Cloudflare DNS module. The global Caddy configuration uses the Cloudflare API token for certificate issuance.

The existing DDNS service includes wildcard records for `tjallo.nl`. Confirm that `keybridge.tjallo.nl` resolves to the public host before deployment.

### Planned application service

Add a `keybridge` service to `../homelab-docker-files/speedmeister/docker-compose.yml` with these properties:

- a versioned and digest-pinned KeyBridge image;
- `restart: unless-stopped`;
- the existing default Compose network;
- no published port;
- a read-only root filesystem;
- no persistent volume;
- dropped capabilities and `no-new-privileges`;
- a health check against internal port 3000;
- a memory limit that matches the relay ciphertext cap.

The service needs no application secret. Caddy owns the existing Cloudflare credential.

### Planned Caddy route

Add a dedicated `keybridge.tjallo.nl` site block to `../homelab-docker-files/speedmeister/caddy/conf/Caddyfile`.

The route must:

- reverse proxy to `keybridge:3000`;
- preserve WebSocket upgrades;
- apply the KeyBridge security headers;
- avoid an access-log directive;
- use the existing automatic certificate setup.

### Required homelab documentation changes

The deployment implementation must also update:

- `../homelab-docker-files/docs/operations.md`;
- the public Caddy route table;
- the service inventory and deployment procedure;
- `../homelab-docker-files/speedmeister/homepage/config/services.yaml`;
- a KeyBridge service guide under the homelab documentation tree.

Do not add a real Cloudflare token or another secret to the repository.

## Dependencies

Use Node.js standard modules for HTTP, cryptographic randomness, timers, static file serving, network address parsing, and process control.

Add these focused dependencies:

- `ws` for the WebSocket server;
- `qrcode-generator` for the browser QR matrix;
- Svelte 5 and Vite for the browser build.

Use TypeScript in strict mode. Use `svelte-check` for Svelte and TypeScript diagnostics. Use the Node.js test runner for relay tests and Playwright for browser flows.

Do not add SvelteKit, Express, a database client, a state library, a logging framework, a dependency injection container, a runtime schema framework, or a browser cryptography package.

Commit the package lock. Review and pin dependency major versions before the first release.

## Repository structure

```text
.
├── .dockerignore
├── Dockerfile
├── compose.dev.yaml
├── compose.yaml
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── src
│   ├── server
│   │   ├── main.ts
│   │   ├── protocol.ts
│   │   ├── rate-limit.ts
│   │   ├── relay.ts
│   │   ├── rooms.ts
│   │   ├── security.ts
│   │   └── static-files.ts
│   ├── shared
│   │   └── envelope.ts
│   └── ui
│       ├── App.svelte
│       ├── crypto.ts
│       ├── main.ts
│       ├── room-state.ts
│       ├── styles.css
│       └── components
│           ├── ReceiverRoom.svelte
│           ├── SecretCard.svelte
│           ├── SenderRoom.svelte
│           └── StartRoom.svelte
├── test
│   ├── protocol.test.ts
│   ├── rate-limit.test.ts
│   ├── rooms.test.ts
│   └── integration
├── e2e
├── docs
│   ├── protocol.md
│   ├── security-model.md
│   └── self-hosting.md
└── README.md
```

Keep browser cryptography in `src/ui/crypto.ts`. Keep room authorization and expiry in `src/server/rooms.ts`. Do not create generic repositories, services, factories, or transport abstractions.

## Error handling

The relay uses stable public error codes such as `busy`, `expired`, `invalid_message`, `not_allowed`, `rate_limited`, `room_unavailable`, and `unsupported_version`.

Expected errors do not include stack traces or room existence details. The sender receives useful local messages after its relay role is authenticated.

A failed decryption remains a browser-local pairing or item error. The browser does not send a plaintext decryption reason to the relay.

A room invariant failure ends the affected room. A process invariant failure closes all rooms and exits so the container can restart.

The relay handles interrupt and termination signals. Shutdown closes WebSockets, removes room references, closes the HTTP listener, and exits within the Compose stop grace period.

## Testing strategy

### Cryptography tests

Run browser cryptography tests in Playwright and compatible Web Crypto tests in Node.js.

Cover these cases:

- both browsers derive the same key from one link and PIN;
- another PIN derives a different key;
- directional keys differ;
- fixed HKDF and AES-GCM vectors match expected bytes;
- modified ciphertext fails authentication;
- modified additional authenticated data fails authentication;
- a repeated message identifier is rejected;
- an expired encrypted item does not reappear;
- the relay frame contains no known plaintext sentinel;
- the room key and PIN never enter a relay message.

Freeze and document the envelope format before implementation proceeds beyond pairing.

### Room and relay tests

Test room transitions with explicit timestamps:

- create, pending, approve, reject, and pending timeout;
- first-receiver slot reservation;
- concurrent receiver rejection;
- sender and receiver reconnect;
- sender grace room termination;
- receiver grace cleanup and return to waiting;
- room extension from **Send** and **Extend** only;
- item expiry, revoke, and encrypted snapshot;
- request idempotency and stale replay;
- process shutdown from each room state.

Test public boundaries:

- malformed and oversized frames;
- unknown room responses that do not reveal existence;
- per-address and global rate limits;
- room and process memory caps;
- untrusted forwarding headers;
- wrong WebSocket origins;
- secret redaction from errors and logs;
- escaped labels and values in Svelte rendering.

### Browser tests

Use two isolated Playwright browser contexts for the sender and receiver.

Cover these flows:

- room creation and QR link generation;
- fragment removal after receiver startup;
- wrong PIN and correct PIN behavior;
- manual sender approval;
- hidden value, reveal, and copy fallback;
- send, expiry, revoke, and reconnect snapshot;
- second receiver rejection;
- sender and receiver page reload within grace;
- room extension and room end;
- security and cache response headers;
- no third-party network request.

### Docker tests

Verify these container properties:

- a clean checkout builds without host Node.js;
- development watch mode sees source changes;
- tests run through Compose;
- the runtime image starts with a read-only root filesystem;
- the runtime image runs as a non-root user;
- no persistent volume appears;
- termination signals close the relay within the grace period;
- the health endpoint reveals no room data;
- the production image contains no development dependency tree or test artifacts.

### Deployment tests

Test the Caddy route on the public domain:

- a publicly trusted certificate loads without a warning;
- HTTPS redirects work;
- WebSocket upgrades remain stable;
- the public origin passes the browser secure-context check;
- Android Clipboard API behavior matches the fallback design;
- room fragments do not appear in Caddy requests or application logs;
- container restart ends all rooms;
- the application container has no public host port.

## Incremental implementation phases

### Phase 1: Docker and Svelte bootstrap

- Create the Docker stages and development Compose file.
- Add the manual Svelte 5 and Vite setup.
- Serve one static application from the Node relay.
- Add Vite WebSocket proxying and Hot Module Replacement.
- Add type checking, formatting, and container test commands.

Exit criterion: A clean checkout starts through Docker and shows the three empty application views.

### Phase 2: Room relay

- Implement bounded room state and explicit transitions.
- Add sender creation and reconnect credentials.
- Add receiver pending and reconnect credentials.
- Add room timers, heartbeats, origin checks, and shutdown.
- Add per-address and global resource limits.

Exit criterion: Relay tests cover all room transitions and concurrent room limits without encrypted payloads.

### Phase 3: Browser encryption

- Freeze the pairing and envelope format in `docs/protocol.md`.
- Implement HKDF and AES-GCM through Web Crypto.
- Add room-link and PIN key derivation.
- Add directional keys, nonces, authenticated headers, and replay checks.
- Add fixed test vectors and plaintext-sentinel tests.

Exit criterion: Two browser contexts exchange authenticated ciphertext that the relay cannot decode.

### Phase 4: Pairing interface

- Add QR and copied-link controls.
- Add the separate PIN input on the receiver.
- Add encrypted pairing proof and sender approval.
- Add pending timeout, rejection, and first-receiver enforcement.
- Remove fragment data from receiver history.

Exit criterion: A physical Android Chrome browser pairs through the public staging origin.

### Phase 5: Secret lifecycle

- Add labeled text input and TTL presets.
- Add encrypted immutable items and relay snapshots.
- Add hidden receiver cards, reveal, copy, expiry, and revoke.
- Add sender and receiver reload recovery through `sessionStorage`.
- Clear browser state at room end.

Exit criterion: Browser tests cover the complete text transfer and reconnect lifecycle.

### Phase 6: Public hardening and transparency

- Apply content limits and public abuse controls.
- Add strict browser security headers.
- Audit all logs and browser storage.
- Add the security model and metadata disclosure.
- Embed release version and asset hashes.
- Generate container checksums and a software bill of materials.

Exit criterion: Security tests and container property tests pass with no known plaintext at the relay boundary.

### Phase 7: Homelab deployment

- Build and publish a versioned container image.
- Add the KeyBridge service to the Speedmeister Compose project.
- Add the Caddy route for `keybridge.tjallo.nl`.
- Add the homepage entry and required homelab documentation.
- Validate DNS, public TLS, WebSockets, headers, and container isolation.

Exit criterion: The public domain completes one sender-to-phone transfer and survives the deployment checklist.

## Planned verification commands

The repository should provide these Docker-first commands:

```text
docker compose -f compose.dev.yaml run --rm relay npm run format:check
docker compose -f compose.dev.yaml run --rm relay npm run check
docker compose -f compose.dev.yaml run --rm relay npm test
docker compose -f compose.dev.yaml run --rm relay npm run test:integration
docker compose -f compose.dev.yaml run --rm e2e npm run test:e2e
docker compose -f compose.dev.yaml run --rm relay npm run build
SOURCE_COMMIT=$(git rev-parse HEAD) docker compose build
```

The application does not exist yet, so these commands are planned interfaces. Each implementation phase must add and run its applicable checks.

The homelab integration must also run its repository validation commands after the configuration changes.

## Acceptance criteria

V1 is ready when all these statements are true:

- A user creates a room without an account.
- The sender browser generates the room key and PIN.
- The pairing link keeps its key in the URL fragment.
- The phone enters the separate PIN before approval.
- The sender approves one receiver.
- A second receiver cannot pair with the same room.
- The sender transfers text to the receiver only.
- The relay stores ciphertext and public metadata without payload keys.
- A modified envelope fails browser authentication.
- Text expires and disappears from both application views.
- The same receiver recovers unexpired encrypted items during reconnect grace.
- Room end invalidates relay credentials and removes retained ciphertext.
- A clean checkout develops, tests, and builds through Docker without host Node.js.
- Caddy serves the public domain with a trusted certificate and working WebSockets.
- The production container uses no database, persistent application volume, or public host port.
- The interface explains server-code trust, metadata exposure, clipboard residue, and the lack of forward secrecy.
