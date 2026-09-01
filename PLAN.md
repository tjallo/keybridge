# KeyBridge v1 implementation plan

## Context

KeyBridge will transfer short-lived secrets from one configured host to one newly configured client on a local network. The project starts from an empty Git repository. Node.js 26.7.0 is installed. The user prefers Svelte 5, few dependencies, no accounts, no cloud service, and no secret persistence.

The plan must resolve the browser bootstrap problem: JavaScript loaded over unauthenticated HTTP cannot establish that it came from the intended host. Application-layer encryption alone does not fix replacement of that first JavaScript response.

## Approach

The first interview round selected an Android browser client served over HTTP, QR pairing with explicit host approval, and a random listening port for each process start. The threat model remains unresolved. An HTTP browser client cannot authenticate its initial JavaScript against an active local-network attacker, so the final plan must either accept that limit or change the client bootstrap.

Treat the random port as routing information and defense against casual scanning, not as authentication. Put the port in the QR code. Cryptographic pairing must remain secure when an attacker knows the port.

The final recommendation will define:

- the threat model and explicit non-goals;
- the trust bootstrap and user-verification steps;
- separate host administration and client transfer surfaces;
- a single-client session state machine;
- the in-memory secret lifecycle;
- local networking, discovery, and reconnect behavior;
- a small Node.js 26 and Svelte 5 implementation with audited protocol boundaries.

## Security findings

- A page at `http://<private-ip>:<port>` is not a secure context. The loopback exception does not apply because `localhost` on Android refers to the phone.
- Browser `SubtleCrypto` and `Clipboard.writeText()` require a secure context. An HTTP client would need inferior fallbacks and still could not authenticate its downloaded code.
- An active network attacker can replace the HTTP HTML or JavaScript before pairing. Replacement code can read QR URL data, falsify approval displays, or exfiltrate each decrypted secret. QR-carried keys and application-layer encryption do not repair this bootstrap.
- Chrome is adding Local Network Access permission and secure-context rules. Exact WebSocket coverage depends on the browser version, so v1 must test its target Chrome versions and must not rely on current gaps as a lasting design.
- A random port reduces noise from casual scans. It does not stop packet observers, port scanners, QR observers, or active network attackers.

## Files to modify

The repository has no application files. This list will be finalized after the architecture decision.

- `package.json`: scripts and the minimum runtime and development dependencies.
- `src/`: host server, protocol, session state, and Svelte user interfaces.
- `test/`: protocol, state-machine, expiry, and integration tests.
- `README.md`: security model, setup, operation, and limitations.

## Reuse

No project code exists to reuse. Prefer Node.js 26 standard-library APIs and browser platform APIs. Add a dependency only when the platform lacks a safe, mature implementation.

## Steps

- [ ] Fix the v1 threat model, supported platforms, and explicit non-goals.
- [ ] Select the client form and trustworthy QR bootstrap.
- [ ] Specify pairing, host approval, transport protection, and transcript binding.
- [ ] Specify the session state machine and single-client enforcement.
- [ ] Specify the secret, clipboard, expiry, revocation, and reconnect lifecycles.
- [ ] Specify network binding, discovery, ports, and deployment behavior.
- [ ] Define modules, data structures, protocol messages, and error handling.
- [ ] Define security, unit, integration, and end-to-end test cases.
- [ ] Split implementation into small, verifiable phases.
- [ ] Document residual risks and operational guidance.

## Verification

The final plan will include:

- automated protocol and state-transition tests;
- tests for replay, wrong keys, stale sessions, concurrent clients, expiry, and revocation;
- browser or native client interoperability tests on each supported platform;
- local-network end-to-end tests, including offline use;
- package, lint, type-check, and Node.js 26 test commands;
- a manual security checklist for QR verification, clipboard clearing, process exit, and network exposure.

## Interview decisions

- Client: Android browser over local HTTP, subject to an explicit decision about its active-attacker limitation.
- Pairing: QR scan followed by host approval.
- Networking: choose a fresh random port at process start and encode it in the QR code.
- Dependencies: use Node.js 26, Svelte 5, and as few mature dependencies as practical.

## Open decisions

- Whether v1 only resists passive network attackers or replaces the HTTP bootstrap to resist active attackers.
- Whether v1 must resist QR observers, other operating-system users on the host, or endpoint malware beyond residue reduction.
- QR contents, approval details, and human-verifiable authentication.
- Reconnect policy and client replacement policy.
- TTL defaults, one-time reads, and clipboard controls.
- Network discovery and behavior on hostile or isolated local networks.
- Host operating systems, client operating systems, and packaging targets.
- Permitted metadata persistence and memory-hardening expectations.
- Features that v1 must exclude.
