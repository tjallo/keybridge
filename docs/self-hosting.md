# Self-hosting

KeyBridge v1 is a single-process, in-memory service designed for one container behind a TLS reverse proxy. It does not support multiple replicas or shared room storage.

```sh
export SOURCE_COMMIT="$(git rev-parse HEAD)"
docker compose build
docker compose up
```

The example binds `127.0.0.1:3000` only for local smoke testing. Production must expose no application port, proxy HTTPS and WebSocket upgrades from Caddy, and set `PUBLIC_ORIGIN` to the exact public HTTPS origin. Set `TRUST_PROXY=1` only when Caddy is the container's sole network peer and set `TRUSTED_PROXY_ADDRESSES` to Caddy's explicit comma-separated container addresses. Forwarding headers from every other socket peer are ignored. Keep Caddy and KeyBridge on a deployment network that untrusted containers cannot join.

The runtime runs as the non-root `node` user, supports a read-only root, uses no persistent volume, drops capabilities, and enables `no-new-privileges`. `/health` returns only `ok`. A restart or termination ends every Room and removes all ciphertext.

Recommended Caddy controls mirror the Relay headers: same-origin CSP, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, HSTS, `no-referrer`, MIME sniff protection, same-origin opener/resource policies, and a restrictive Permissions Policy. Do not enable a KeyBridge access log.

Release artifacts:

```sh
SOURCE_COMMIT=$(git rev-parse HEAD) docker compose build
# In the build container:
npm run release:checksums
npm run release:sbom
```

Publish the semantic version, source commit, package lock, image digest, `dist/SHA256SUMS`, and `dist/sbom.cdx.json`. Do not claim reproducibility until two clean builds match.
