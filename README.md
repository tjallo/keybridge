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

## Container image publishing

Enable Actions and Packages for the Gitea repository. Permit the built-in Actions token to read repository contents and write packages. The workflows request these permissions for each image build.

A pushed `x.x.x` tag publishes the matching version and `latest` images. The tag must match the `package.json` version.

```sh
git tag -a 1.0.1 -m "Release 1.0.1"
git push origin 1.0.1
```

Run **Publish development image** from the Gitea Actions page to replace the `development` image. Tailnet clients can pull published images after Gitea authentication:

```sh
docker pull gitea.tailebf42a.ts.net/tjallo/keybridge:1.0.1
docker pull gitea.tailebf42a.ts.net/tjallo/keybridge:development
```

Read [the frozen protocol](docs/protocol.md), [security model](docs/security-model.md), and [self-hosting guide](docs/self-hosting.md). The bounded security claim and browser bootstrap limitation are part of the product, not optional deployment notes.
