# KeyBridge

KeyBridge transfers short-lived encrypted text from one desktop Sender to one phone Receiver. It uses an in-memory Relay. It has no accounts, database, analytics, files, or persistent vault.

KeyBridge is for short-lived secrets such as passwords, tokens, recovery codes, and configuration text. It is not a password manager or a long-term secret store.

## Security model

The browser encrypts each secret before it sends the secret to the Relay. The Relay does not receive the room key, PIN, or plaintext.

The Relay can retain encrypted traffic and metadata. The server that supplies the browser application can serve modified JavaScript. KeyBridge does not protect against compromised endpoints, browser extensions, screen capture, or clipboard residue. Encrypted envelope version 1 has no application-layer forward secrecy.

Read the [security model](docs/security-model.md) before you deploy KeyBridge.

## Quick start

You need Docker and Docker Compose.

```sh
git clone https://github.com/tjallo/keybridge.git
cd keybridge
SOURCE_COMMIT="$(git rev-parse HEAD)" docker compose build
docker compose up
```

Open `http://localhost:3000`. For a physical phone, serve KeyBridge through a trusted HTTPS origin and set `PUBLIC_ORIGIN` to that exact origin.

## Development

Set the container user to your local user. Then start the Relay and Vite development server:

```sh
export LOCAL_UID="$(id -u)"
export LOCAL_GID="$(id -g)"
docker compose -f compose.dev.yaml up --build
```

Open `http://localhost:5173` on the desktop. The loopback secure-context exception does not apply to a physical phone.

Run checks in the development container:

```sh
docker compose -f compose.dev.yaml run --rm relay npm run format:check
docker compose -f compose.dev.yaml run --rm relay npm run check
docker compose -f compose.dev.yaml run --rm relay npm test
docker compose -f compose.dev.yaml run --rm relay npm run test:integration
docker compose -f compose.dev.yaml run --rm e2e npm run test:e2e
docker compose -f compose.dev.yaml run --rm relay npm run build
```

## Connection recovery

KeyBridge supports current Chrome, Firefox, and Safari on desktop and mobile. The browser reconnects after a temporary network loss. It retries during the Relay's 60-second grace period and restores encrypted pairing frames and active items from the Relay.

Room actions pause while the browser reconnects. An unresolved idempotent command keeps its request identifier and resumes after the connection returns. The browser clears the session after grace expiry, a terminal Relay response, explicit leave, or room end.

A Relay restart ends every room. Automatic reconnect does not recreate room data after a restart.

## Container images

Release tags publish the runtime image to GitHub Container Registry (GHCR):

```sh
docker pull ghcr.io/tjallo/keybridge:2.2.0
docker pull ghcr.io/tjallo/keybridge:latest
```

If the GHCR package is private, authenticate with `docker login ghcr.io` before you pull it.

## Releases

The GitHub release workflow runs when you push a tag in the `x.y.z` format. The tag must equal the `package.json` version. It publishes the version tag and `latest` to GHCR.

```sh
VERSION=0.2.0
npm version "$VERSION" --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): prepare version $VERSION"
git tag -a "$VERSION" -m "Release $VERSION"
git push origin main "$VERSION"
```

Create release checksums and a software bill of materials (SBOM) when you publish a release:

```sh
docker compose -f compose.dev.yaml run --rm -e SOURCE_COMMIT="$(git rev-parse HEAD)" relay npm run build
docker compose -f compose.dev.yaml run --rm relay npm run release:checksums
docker compose -f compose.dev.yaml run --rm relay npm run release:sbom
```

## Self-hosting

KeyBridge runs as one in-memory process. Do not use multiple replicas or attach persistent room storage.

Set `PUBLIC_ORIGIN` to the exact HTTPS origin that users open. Put the container behind a TLS reverse proxy that forwards WebSocket upgrades. Expose no application port to the public network.

```sh
export PUBLIC_ORIGIN=https://keybridge.example
export SOURCE_COMMIT="$(git rev-parse HEAD)"
docker compose build
docker compose up -d
```

Set `TRUST_PROXY=1` and `TRUSTED_PROXY_ADDRESSES` only when the proxy is the container's sole network peer.

Read the [self-hosting guide](docs/self-hosting.md) for deployment constraints. Read the current [transport protocol](docs/protocol.md) and archived [version 1 protocol](docs/protocol-v1.md).

## License

KeyBridge uses the [MIT License](LICENSE). You can use it in commercial work if you retain the copyright and license notice.
