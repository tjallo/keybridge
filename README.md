# KeyBridge

KeyBridge transfers short-lived encrypted text from one desktop **Sender** to one phone **Receiver** through an in-memory **Relay**. It has no accounts, database, analytics, files, or persistent vault.

## Docker-first development

```sh
docker compose -f compose.dev.yaml up --build
docker compose -f compose.dev.yaml run --rm relay npm run format:check
docker compose -f compose.dev.yaml run --rm relay npm run check
docker compose -f compose.dev.yaml run --rm relay npm test
docker compose -f compose.dev.yaml run --rm relay npm run test:integration
docker compose -f compose.dev.yaml run --rm e2e npm run test:e2e
docker compose -f compose.dev.yaml run --rm relay npm run build
SOURCE_COMMIT=$(git rev-parse HEAD) docker compose build
```

Open <http://localhost:5173>. A physical phone requires a Caddy-backed trusted HTTPS origin; the loopback secure-context exception applies only to the desktop.

Read [the frozen protocol](docs/protocol.md), [security model](docs/security-model.md), and [self-hosting guide](docs/self-hosting.md). The bounded security claim and browser bootstrap limitation are part of the product, not optional deployment notes.
