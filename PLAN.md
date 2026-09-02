# KeyBridge Full Refactor Plan

## Context

KeyBridge works as a small Svelte client and an in-memory WebSocket relay, but the current structure makes connection recovery and maintenance difficult. `src/ui/App.svelte` contains room state, storage, cryptography orchestration, WebSocket lifecycle, request tracking, and view routing in one 603-line component. `src/server/relay.ts` combines upgrade handling, peer lifecycle, command dispatch, room transitions, maintenance, and protocol errors in 446 lines. Several files use compressed declarations and control flow that obscure state transitions.

The refactor will preserve KeyBridge's product scope: transfer short-lived encrypted text without accounts or persistent server storage. It will fix existing behavior, including automatic reconnection, without adding product features.

## Approach

Use an incremental, test-first refactor. Define client and relay lifecycle contracts, then add regression tests for broken paths. Split orchestration from transport, state, cryptography, and presentation in small phases. Keep the application runnable and the relevant tests green after each phase. The user permits a protocol revision and session invalidation. Use transport protocol version 2 to remove the lifecycle gaps described below. Preserve the documented security properties and deployment inputs.

The automatic reconnect contract covers current Chrome, Firefox, and Safari on desktop and mobile. The client retries with bounded exponential backoff and jitter until the relay's grace deadline. The client stops on a terminal response or an intentional close. The UI shows `connecting`, `connected`, `reconnecting`, and terminal states without requiring a reload. The user permits UI code cleanup, accessibility changes, and a visual redesign.

The final code should use consistent names, one responsibility per module, explicit state types, readable control flow, and project-wide automated formatting. Documentation will describe the resulting behavior and recovery limits.

### Target structure

- `src/ui/session/model.ts` defines discriminated sender, receiver, and connection states. It contains no Svelte or WebSocket code.
- `src/ui/session/storage.ts` validates a versioned session record. It rejects version 1 records and malformed version 2 records without partial restoration.
- `src/ui/session/transport.ts` owns the socket generation, backoff scheduler, grace deadline, command queue, and inbound message serialization. Tests inject the socket factory, clock, timer, and random source.
- `src/ui/session/controller.ts` coordinates protocol events, cryptography, persistence, and item state. It exposes one read-only snapshot and explicit user actions to Svelte.
- `src/ui/App.svelte` selects pages from the controller snapshot. Page components render data and emit typed actions.
- `src/shared/protocol.ts` defines version 2 commands, events, errors, constants, and decoders for untrusted frames. `src/shared/envelope.ts` continues to define encrypted envelope version 1.
- `src/server/rooms.ts` models the room phase as a discriminated union. Connection ownership and grace deadlines remain separate from the pairing phase.
- `src/server/peer-registry.ts` owns the current socket generation for each role and ignores callbacks from replaced sockets.
- `src/server/relay-commands.ts` validates state-specific commands and returns typed effects. `src/server/relay.ts` handles WebSocket input, output, heartbeat maintenance, and shutdown.
- `src/server/config.ts` validates startup environment variables before the server starts.

### Protocol version 2 lifecycle

- Each browser generates a high-entropy role credential before `create` or `join`. The browser stores the credential in session storage and never puts it in the pairing link.
- Initial attachment is idempotent for the same room, role, and credential. A reconnect uses `resume` and receives one role-specific room snapshot.
- An authenticated new socket replaces an older socket for the same role. The relay closes the old socket without changing the replacement's room state.
- A snapshot includes the room phase, room deadline, connection state, active encrypted items, and any encrypted pairing frame that the role still needs.
- The relay scopes completed request results by role and `requestId`. The client replays only unresolved commands whose server effects are idempotent.
- The client computes a conservative reconnect deadline from the 60-second grace period and heartbeat detection allowance. A successful resume replaces that estimate with relay state.
- Terminal errors, room expiry, explicit leave, explicit end, and session replacement stop retries and clear sensitive session state.

### Non-goals

- Do not add accounts, persistent relay storage, analytics, telemetry, file transfer, multiple receivers, or multiple relay replicas.
- Do not claim forward secrecy or secure erasure.
- Do not change the encrypted envelope, key derivation, metadata exposure, or resource limits without a separate security reason and test vector.
- Do not keep version 1 browser sessions compatible. Keep the version 1 protocol document as an archive.

## Files to modify

Critical paths:

- `src/ui/App.svelte`: reduce the component to application composition and view routing.
- `src/ui/session/model.ts`, `src/ui/session/storage.ts`, `src/ui/session/transport.ts`, and `src/ui/session/controller.ts`: own typed state, validated persistence, reconnect policy, request tracking, and session orchestration.
- `src/ui/components/*.svelte`: normalize component contracts, connection states, accessibility, and presentation code.
- `src/ui/crypto.ts`: preserve primitives while clarifying public contracts and validation boundaries.
- `src/server/relay.ts`: separate transport, peer lifecycle, command handling, and maintenance.
- `src/server/rooms.ts`: make room transitions and reconnect grace periods explicit.
- `src/server/config.ts`, `src/server/peer-registry.ts`, and `src/server/relay-commands.ts`: own startup validation, peer generations, and state-specific command dispatch.
- `src/server/protocol.ts`: remove this file after moving shared wire contracts out of the server-only directory.
- `src/shared/protocol.ts`: define both frame directions, identifiers, errors, constants, and runtime validation.
- `src/shared/envelope.ts`: separate the frozen cryptographic envelope version from the transport protocol version.
- `test/**/*.test.ts` and `e2e/keybridge.spec.ts`: add lifecycle and reconnect regression coverage.
- `test/session-model.test.ts`, `test/session-storage.test.ts`, `test/transport.test.ts`, and `test/config.test.ts`: test state transitions, stored-record rejection, reconnect scheduling, request replay, and startup validation without a browser UI.
- `playwright.config.ts`: run recovery flows against the agreed browser matrix.
- `src/ui/styles.css`: retain global tokens, resets, and shared primitives after styles move to their components.
- `docs/protocol-v1.md` and `docs/protocol.md`: archive the frozen version 1 document and make version 2 the current protocol reference.
- `docs/security-model.md`, `docs/self-hosting.md`, and `README.md`: align claims and operating instructions with the refactor.
- `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `svelte.config.js`, `.prettierrc`, and `.prettierignore`: make commands, strict checks, browser versions, and formatting deterministic.
- `Dockerfile`, `compose*.yaml`, `.dockerignore`, and release workflows: align Node and Playwright versions and verify the production build path.
- New check workflows under `.github/workflows/` and `.gitea/workflows/`: run formatting, type checks, tests, and builds before release publication.
- `scripts/*.mjs`: preserve release metadata and checksum behavior while applying the same readability rules.

Generated `build/` and `dist/` files remain untracked. Build commands regenerate them; implementation work must not edit them directly.

## Reuse

Preserve and reuse these existing concepts unless a regression test shows a defect:

- Keep the room transition constraints, grace periods, expiry behavior, item retention, and resource limits from `src/server/rooms.ts`.
- Keep `RateLimiter` and `addressGroup` from `src/server/rate-limit.ts`.
- Move the runtime parsing pattern from `src/server/protocol.ts` into shared decoders for both frame directions.
- Keep the envelope predicates, authenticated header checks, and size limits from `src/shared/envelope.ts`.
- Keep the cryptographic primitives, test vectors, key derivation, and replay checks from `src/ui/crypto.ts`.
- Adapt `Room.completeRequest()` and `Room.requestResult()` into a role-scoped cache for safe mutation replay.
- Keep independent role grace deadlines, but pair them with the new client-generated credentials and peer generation checks.
- Extend the unit, integration, and Playwright harnesses in `test/`, `e2e/`, and `playwright.config.ts`.

## Current defects and constraints

- `src/ui/App.svelte` reconnects only during initial session restoration and after a rejected pairing. A normal network loss tells the user to reload.
- Restoration retries only eight times at 250 ms intervals. It reacts to `room_unavailable` responses instead of transport failures and does not use the room deadline.
- `send()` silently drops commands when the socket is not open. Mutation timers then fail without distinguishing transport loss from relay rejection.
- The client parses relay frames with an unchecked `JSON.parse` call in the socket callback. Invalid server data can escape the message handler.
- Client room state uses unrelated strings and mutable variables instead of a state model. This permits invalid combinations of credentials, keys, views, and reconnect flags.
- The relay and `Room` split lifecycle state across peer maps, booleans, grace timestamps, and `activeState`. The implementation requires stronger invariants and deterministic timer tests.
- Protocol version 1 has client-message types in `src/server/protocol.ts`, but server messages remain untyped objects in `src/server/relay.ts` and unchecked records in the client.
- The version 1 protocol already caches completed mutation results by `requestId`. The new client transport can reuse this idempotency rule to replay in-flight mutations after an authenticated resume.
- Current tests cover room resume and one relay mutation replay, but no test drives automatic client reconnect after an open session loses transport.
- A disconnect can lose a pairing request or approval event. The relay does not retain either event for resume, so one side can restore into an unrecoverable handshake state.
- The server generates each role credential. A disconnect before the client receives that credential cannot resume. Version 2 should let each client generate its own high-entropy resume credential in the initial command.
- The room cache keys completed requests by `requestId` only. Version 2 should scope idempotency to the role to prevent one role from colliding with the other role's request.
- `Relay.#closed()` disconnects the room even when the closing peer is no longer the role's current peer. A late close from an old socket can mark a replacement connection offline.
- `Relay.#resume()` rejects a new socket while the old socket still appears open. Heartbeat cleanup can take longer than the client's two-second restoration retry budget, so a half-open socket can make restoration fail.
- Client cleanup leaves nonces, replay guards, reconnect flags, and some room state alive across rooms. The next room can inherit an invalid combination before later events overwrite it.
- Client message handlers run concurrently because the socket callback does not await or serialize `handle()`. Cryptographic event processing can therefore complete out of wire order.
- Current end-to-end tests cover reload restoration in one default Playwright browser. They do not simulate an offline interval, relay restart, grace expiry, disconnect during pairing, or browser-specific behavior.
- `playwright.config.ts` defines no browser projects. The lockfile and Docker image both resolve to Playwright 1.62.1, but `package.json` permits any compatible `^1.52.0` release. Use one exact version source to prevent future drift.
- `src/ui/styles.css` is a 925-line global sheet with repeated page selectors, generic utility names, `!important`, and no reduced-motion rule for its pulse animation. The refactor should keep styles local where practical and retain a small global foundation.
- UI controls do not expose reconnect progress. The PIN and send interactions use click handlers rather than forms, which limits keyboard submit behavior and native validation.
- Server and UI files duplicate protocol errors, states, time-to-live values, identifier checks, and casts. Shared constants and decoders should replace this drift without coupling server internals to Svelte.
- The current style history merged declarations and reduced line count after an earlier formatting pass. The new policy should favor scanability: one declaration per statement, braces for multi-branch control flow, named helpers for domain checks, and whitespace between lifecycle phases.
- The repository publishes images but has no check workflow. Release jobs can publish without running the documented format, type, unit, integration, end-to-end, and build checks.
- The Docker stages use a floating Node 26 Alpine image for builds and Node 26.0.0 for runtime. Pin one supported Node version across local, test, and production paths.
- `src/server/main.ts` reads environment variables without validation. Invalid ports or origins reach Node and WebSocket setup as runtime failures instead of clear startup errors.
- `docs/protocol.md` declares version 1 frozen. If the refactor changes frames or lifecycle semantics, the documentation must preserve version 1 and define version 2 instead of rewriting version 1.
- Cryptographic primitives and envelope validation already have focused modules. The refactor should preserve these boundaries and add typed payload validation around them.

## Steps

### 1. Lock the contracts with tests

- [ ] Write the room, peer ownership, request replay, restoration, grace, expiry, rejection, and shutdown invariants as test cases.
- [ ] Add regressions for a stale socket closing after replacement, a half-open socket during resume, lost pairing frames, cross-role request identifiers, invalid room identifiers, and incomplete session reset.
- [ ] Add shared decoder tests for every client command, server event, malformed frame, extra-large value, protocol mismatch, and public error.

### 2. Introduce transport protocol version 2

- [ ] Separate `TRANSPORT_VERSION` from `ENVELOPE_VERSION` and keep the existing envelope test vectors unchanged.
- [ ] Define client-generated role credentials, idempotent initial attachment, authenticated resume, role-scoped request results, and typed role snapshots.
- [ ] Move wire types, constants, identifier checks, public errors, and both frame decoders into `src/shared/protocol.ts`.
- [ ] Preserve `docs/protocol.md` as `docs/protocol-v1.md`, then document version 2 in a new current reference.

### 3. Refactor the relay domain and transport

- [ ] Replace room booleans with a discriminated phase and separate role connection records.
- [ ] Retain the encrypted pending pairing request and approval response until each required role can recover it or the room ends.
- [ ] Scope completed request results to a role and preserve the original response for safe retries.
- [ ] Extract the peer registry and command dispatcher from `Relay`.
- [ ] Let an authenticated replacement socket supersede a stale socket for the same role.
- [ ] Guard close, error, heartbeat, and timeout callbacks with peer generation identity.
- [ ] Inject time where lifecycle tests need deterministic deadlines.
- [ ] Keep rate limits, envelope limits, origin checks, in-memory storage, and shutdown cleanup intact.

### 4. Build the client session core

- [ ] Create a pure session model with explicit sender, receiver, connection, and terminal states.
- [ ] Add a versioned session-storage decoder and reject old or malformed records as one atomic operation.
- [ ] Build one transport owner for socket generations, exponential backoff, jitter, the grace deadline, online wake-ups, visibility wake-ups, and timer cancellation.
- [ ] Serialize inbound frame handling to preserve WebSocket order during asynchronous cryptographic work.
- [ ] Queue commands only in valid states. Preserve each unresolved mutation `requestId` and replay safe commands after resume.
- [ ] Distinguish relay rejection, retryable transport loss, grace expiry, protocol failure, and intentional closure.
- [ ] Reset credentials, nonces, keys, replay guards, pending requests, timers, and connection flags when the session ends.

### 5. Recompose the Svelte interface

- [ ] Move cryptographic and session effects out of `App.svelte` and expose a read-only controller snapshot.
- [ ] Give each page component typed data and action properties with no transport knowledge.
- [ ] Show connecting and reconnecting status, keep room actions safe during recovery, and show one terminal recovery message when grace expires.
- [ ] Use semantic forms, explicit button types, accessible status regions, keyboard submit behavior, and native input attributes.
- [ ] Keep the current visual identity while correcting hierarchy, mobile layouts, focus states, reduced motion, and connection feedback.
- [ ] Split the global stylesheet into a small foundation and component-owned styles. Remove repeated selectors and `!important` rules.

### 6. Refactor supporting code and project checks

- [ ] Add typed startup configuration with clear validation for the host, port, public origin, and proxy settings.
- [ ] Refactor static serving for explicit methods, asset 404 responses, application-route fallback, stream errors, and graceful shutdown tests.
- [ ] Keep safe structured logs free of room IDs, credentials, ciphertext, links, PINs, values, labels, and full addresses.
- [ ] Apply one readability policy across source, tests, scripts, configuration, workflows, deployment files, and documentation.
- [ ] Use one declaration per statement, braces around branch bodies, named domain checks, block-style YAML, and whitespace between lifecycle phases.
- [ ] Pin one Node version across Docker stages.
- [ ] Pin the Playwright package and browser image to the same version.
- [ ] Remove obsolete type packages and avoid new runtime dependencies.

### 7. Expand automation and documentation

- [ ] Add Chromium, Firefox, and WebKit projects to Playwright.
- [ ] Add matching GitHub and Gitea check workflows for format, types, unit tests, integration tests, end-to-end tests, and production builds.
- [ ] Run the same checks before release image publication.
- [ ] Update the README, security model, self-hosting guide, release metadata, and protocol links.
- [ ] Run the full verification matrix and review dead code, names, formatting, timer disposal, and security invariants.

## Verification

Dependencies are absent from the current `node_modules`, so package-based checks could not run during planning. The available tests ran against the existing build output. Room, protocol, rate-limit, security, static-file, release-script, and cryptography tests passed. The integration and end-to-end suites could not run without installed packages.

Run these automated checks after each relevant phase:

```sh
npm run format:check
npm run check
npm test
npm run test:integration
npm run test:e2e
npm run build
```

Cover these cases at the correct test layer:

- Unit tests: cryptographic vectors, room transitions, protocol decoding, stored-session decoding, backoff bounds, deadline stopping, queue replay, timer disposal, rate limits, startup configuration, static files, and release metadata.
- Relay integration tests: disconnect both roles in either order, replace a half-open socket, ignore a stale close, recover each lost pairing frame, replay a request once, reject a stale credential, expire each grace period, and shut down every peer.
- Browser tests: refresh each role, lose and restore the network during pairing and after pairing, preserve unsent input, deliver retained items after recovery, revoke from either role, leave, end, and show a terminal state after grace expiry.
- Browser matrix: run Chromium, Firefox, and WebKit desktop projects. Add mobile Chrome and mobile Safari viewport and touch projects for responsive and lifecycle smoke tests.
- Manual browser checks: background and restore a real mobile tab, switch networks, use keyboard-only navigation, inspect screen-reader status announcements, and enable reduced motion.
- Production checks: build the image, start the built relay, call `/health`, load an application route, verify a missing asset returns 404, verify WebSocket origin rejection, send `SIGTERM`, and confirm clean exit before the container grace limit.
- Documentation review: compare protocol and security claims with `src/shared/protocol.ts`, `src/shared/envelope.ts`, `src/server/rooms.ts`, and the final test cases.

Run the container paths when Docker is available:

```sh
SOURCE_COMMIT="$(git rev-parse HEAD)" docker compose build
docker compose -f compose.dev.yaml run --rm relay npm run format:check
docker compose -f compose.dev.yaml run --rm relay npm run check
docker compose -f compose.dev.yaml run --rm relay npm test
docker compose -f compose.dev.yaml run --rm relay npm run test:integration
docker compose -f compose.dev.yaml run --rm e2e npm run test:e2e
```

## Confirmed decisions

- The refactor may revise the protocol and invalidate sessions from version 1.
- The refactor may change UI code, accessibility, behavior, layout, and visual styling.
- The support target is current Chrome, Firefox, and Safari on desktop and mobile.
- Automatic reconnect continues until the relay grace deadline or a terminal response.
