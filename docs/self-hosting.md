# Self-hosting

KeyBridge runs as one in-memory process behind a Transport Layer Security (TLS) reverse proxy. This guide uses Docker Compose and Caddy.

## Deployment constraints

Apply these constraints to each deployment:

- Run one KeyBridge replica.
- Do not add persistent room storage.
- Set `PUBLIC_ORIGIN` to the exact public HTTPS origin.
- Expose KeyBridge only to the reverse proxy.
- Forward WebSocket connections on `/ws`.
- Keep access logging disabled for KeyBridge requests.

A restart or termination ends every room and removes its ciphertext. Horizontal replicas cannot share room state.

## Prepare DNS and ports

Create a DNS record for the KeyBridge domain. Point the record to the server that runs Caddy.

Permit inbound TCP traffic on ports 80 and 443. Caddy uses these ports for certificate management and HTTPS traffic.

## Create the Compose file

Create a deployment directory and save this file as `compose.yaml`:

```yaml
services:
  caddy:
    image: caddy:2.10-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
      - '443:443/udp'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      edge:
      keybridge:
        ipv4_address: 172.30.0.2

  keybridge:
    image: ghcr.io/tjallo/keybridge:2.2.0
    restart: unless-stopped
    environment:
      PUBLIC_ORIGIN: https://keybridge.example.com
      TRUST_PROXY: '1'
      TRUSTED_PROXY_ADDRESSES: 172.30.0.2
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: [CMD, wget, -q, -O, /dev/null, http://127.0.0.1:3000/health]
      interval: 10s
      timeout: 3s
      retries: 3
    stop_grace_period: 10s
    networks:
      keybridge:
        ipv4_address: 172.30.0.3

networks:
  edge:
  keybridge:
    internal: true
    ipam:
      config:
        - subnet: 172.30.0.0/29

volumes:
  caddy_data:
  caddy_config:
```

Replace `keybridge.example.com` with the public domain. Select another private subnet if `172.30.0.0/29` conflicts with an existing Docker network.

The static Caddy address permits an exact `TRUSTED_PROXY_ADDRESSES` value. KeyBridge ignores forwarding headers from every other peer.

## Create the Caddyfile

Save this file as `Caddyfile` in the deployment directory:

```caddyfile
keybridge.example.com {
    reverse_proxy keybridge:3000
}
```

Replace the domain with the value from `PUBLIC_ORIGIN`. Caddy obtains and renews the TLS certificate. The `reverse_proxy` directive supports WebSocket upgrades without more configuration.

Do not add the Caddy `log` directive for this site. Caddy does not write an HTTP access log unless the configuration enables one.

KeyBridge supplies its own security headers. These headers include a same-origin Content Security Policy, HSTS, `no-referrer`, MIME sniff protection, and restrictive browser permissions.

## Start the deployment

If the container package requires authentication, sign in to the GitHub Container Registry (GHCR):

```sh
docker login ghcr.io
```

Pull and start both services:

```sh
docker compose pull
docker compose up -d
```

Inspect the service state:

```sh
docker compose ps
docker compose logs --tail 100 caddy keybridge
```

Request the health endpoint through Caddy:

```sh
curl --fail --silent --show-error https://keybridge.example.com/health
```

The command must print `ok`.

## Use an existing Caddy container

Attach the existing Caddy container and KeyBridge to a private Docker network. Give Caddy a static address on that network.

Set these KeyBridge variables:

```dotenv
PUBLIC_ORIGIN=https://keybridge.example.com
TRUST_PROXY=1
TRUSTED_PROXY_ADDRESSES=<Caddy address on the private network>
```

Add this site block to the existing Caddyfile:

```caddyfile
keybridge.example.com {
    reverse_proxy keybridge:3000
}
```

Do not publish the KeyBridge container port when Caddy shares its Docker network.

## Update KeyBridge

Change the image tag to the required release. Pull and recreate only the KeyBridge service:

```sh
docker compose pull keybridge
docker compose up -d keybridge
```

The update ends all active rooms. Check the health endpoint after the new container starts.

For stronger image pinning, replace the version tag with the published image digest.

## Proxy trust

Leave `TRUST_PROXY=0` when clients connect directly to KeyBridge. In that mode, the Relay uses the socket address for rate limiting.

Set `TRUST_PROXY=1` only when the configured proxy is the container's sole network peer. `TRUSTED_PROXY_ADDRESSES` accepts comma-separated IP addresses, not host names or network ranges.

Caddy supplies `X-Forwarded-For`. KeyBridge accepts that header only when the socket peer matches a trusted address.

## Runtime properties

The production image has these properties:

- It runs as the non-root `node` user.
- It supports a read-only root filesystem.
- It requires no persistent KeyBridge volume.
- It stores temporary runtime files under `/tmp`.
- It exposes an `ok` response from `/health`.
- It serves no third-party browser resources.

Read the [security model](security-model.md) for the complete trust boundaries. Read the [development guide](development.md) to build an image from source.
