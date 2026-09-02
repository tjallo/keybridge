# Development

This guide covers the Docker development environment, repository checks, builds, and release preparation.

## Requirements

Install these tools:

- Docker Engine
- Docker Compose
- Git

The container environment supplies Node.js, npm, and the Playwright browsers. Run all commands from the repository root.

## Start the development environment

Set the container user to your local user:

```sh
export LOCAL_UID="$(id -u)"
export LOCAL_GID="$(id -g)"
```

Start the Relay and Vite development server:

```sh
docker compose -f compose.dev.yaml up --build
```

Open `http://localhost:5173` on the desktop. The Vite server proxies WebSocket connections to the Relay container.

The loopback secure-context exception does not apply to a physical phone. Use a trusted HTTPS origin for tests on a physical phone.

## Development services

| Service | Purpose                                                   |
| ------- | --------------------------------------------------------- |
| `relay` | Compiles and runs the Relay with Node.js watch mode       |
| `web`   | Runs the Vite development server on port 5173             |
| `e2e`   | Runs Playwright tests through the optional `test` profile |

The Compose file stores `node_modules` in a named volume. Source files remain on the host through a bind mount.

## Run repository checks

Run each check in a clean development container:

```sh
docker compose -f compose.dev.yaml run --rm relay npm run format:check
docker compose -f compose.dev.yaml run --rm relay npm run check
docker compose -f compose.dev.yaml run --rm relay npm test
docker compose -f compose.dev.yaml run --rm relay npm run test:integration
docker compose -f compose.dev.yaml run --rm e2e npm run test:e2e
docker compose -f compose.dev.yaml run --rm relay npm run build
```

The browser test script runs the suite in these projects:

- Chromium desktop
- Firefox desktop
- WebKit desktop
- Chrome mobile emulation
- Safari mobile emulation

Continuous integration uses two Playwright workers and one retry.

## Run checks with local Node.js

The repository requires the Node.js version in `.nvmrc`.

```sh
nvm use
npm ci
npm run format:check
npm run check
npm test
npm run test:integration
```

Install browser dependencies before you run Playwright on the host:

```sh
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
```

## Build the runtime image

Set the source commit before the build:

```sh
export SOURCE_COMMIT="$(git rev-parse HEAD)"
docker compose build
```

The build writes the package version, source commit, protocol versions, and asset hashes to `dist/release.json`.

Start the built image for a local smoke test:

```sh
docker compose up
```

Open `http://localhost:3000`. Stop the stack after the test:

```sh
docker compose down
```

## Prepare a release

Choose a semantic version in `x.y.z` format. Update the package files without creating an npm tag:

```sh
VERSION=2.2.0
npm version "$VERSION" --no-git-tag-version
```

Update versioned examples and release test fixtures. Run all repository checks before you create the release commit.

```sh
git add package.json package-lock.json README.md test/release-scripts.test.ts
git commit -m "chore(release): prepare version $VERSION"
```

Create and push an annotated Git tag:

```sh
git tag -a "$VERSION" -m "Release $VERSION"
git push origin main "$VERSION"
```

The release workflow rejects a tag that does not equal the `package.json` version. A valid tag publishes the version tag and `latest` container tag.

## Create release artifacts

Build the client with the source commit:

```sh
docker compose -f compose.dev.yaml run --rm \
  -e SOURCE_COMMIT="$(git rev-parse HEAD)" \
  relay npm run build
```

Create checksums and a CycloneDX software bill of materials (SBOM):

```sh
docker compose -f compose.dev.yaml run --rm relay npm run release:checksums
docker compose -f compose.dev.yaml run --rm relay npm run release:sbom
```

Publish these values and files with the release:

- Semantic version
- Source commit
- Package lock
- Container digest
- `dist/SHA256SUMS`
- `dist/sbom.cdx.json`

Do not claim reproducible builds until two clean builds produce matching output.
