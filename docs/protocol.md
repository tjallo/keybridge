# KeyBridge transport protocol version 3

Transport protocol version 3 defines the JSON frames between each browser and the Relay. It uses encrypted envelope version 2.

The Relay accepts bounded JSON text frames on `/ws`. The Relay rejects binary frames. Each frame contains `"version": 3` and a `type` field.

## Identifiers and credentials

A room identifier is a 22-character base64url value. A request identifier is a 16-to-64-character base64url value.

Each browser generates a 32-byte random role credential before its first connection. Base64url encoding produces 43 characters. The browser stores the credential in `sessionStorage`.

The Relay treats the credential as a capability for one role. A connection with the correct credential replaces an older connection for that role.

## Transport frames

The first command on a socket is `create`, `join`, or `resume`. Commands after attachment are `pair`, `approve`, `reject`, `item`, `revoke`, `extend`, `end`, and `leave`.

The Relay sends these events:

- `ready` includes the current room snapshot.
- `pair_request` sends an encrypted Receiver request to the Sender.
- `approved` sends an encrypted Sender approval to the Receiver.
- `rejected` reports a rejected pairing request.
- `item` sends an encrypted item to the Receiver.
- `revoked` sends an encrypted revocation to the other role.
- `ack` confirms a command.
- `room_state` reports a lifecycle change.
- `room_ended` reports a terminal reason.
- `error` reports a public protocol error.

Every command contains a random `requestId`. The Relay caches completed outcomes by role and request identifier. A repeated request receives the original response without repeating the operation.

The attachment commands contain these fields:

- `create`: `roomId`, Sender `credential`, and `requestId`;
- `join`: `roomId`, Receiver `credential`, and `requestId`;
- `resume`: `roomId`, `role`, role `credential`, and `requestId`.

The `ready` event repeats the attachment `requestId` and gives the mode and room snapshot. The mode is `created`, `joined`, or `resumed`. The snapshot contains a room status, retained item envelopes, and the applicable pairing envelope.

The active commands contain these fields:

- `pair`, `approve`, and `item`: an encrypted `envelope` and `requestId`;
- `revoke`: an item identifier, a control `envelope`, and `requestId`;
- `reject`, `extend`, `end`, and `leave`: `requestId`.

The `pair_request` and `approved` events contain the source request identifier and envelope. The `item` event contains an envelope. The `revoked` event contains the public item identifier and control envelope.

## Room lifecycle

The public room states are:

- `WAITING`: The room can reserve one Receiver.
- `PAIR_PENDING`: The Relay received one encrypted pairing request.
- `PAIRED`: The Sender approved the Receiver.
- `SENDER_GRACE`: The Sender is in its reconnect period.
- `RECEIVER_GRACE`: The Receiver is in its reconnect period.

Each role has an independent 60-second reconnect period. Sender expiry ends the room. Receiver expiry removes retained items and returns the room to `WAITING`. A pending pairing request also expires after 60 seconds.

A room expires 10 minutes after creation, accepted item storage, or extension. The Relay retains encrypted items until item expiry, revocation, Receiver expiry, or room end. It retains the applicable pairing frame for a resume snapshot.

A browser reconnects with bounded backoff and sends `resume`. The browser uses the same role credential. It replays an unresolved command with the original request identifier and encrypted envelope.

## Limits and errors

Frames are below 96 KiB. Encrypted envelopes are at most 72 KiB. Item plaintext is at most 64 KiB. A room retains at most 10 items and 256 KiB of encrypted item data.

Item time-to-live values are 30, 60, 120, or 300 seconds. Public error codes are `busy`, `expired`, `invalid_message`, `not_allowed`, `rate_limited`, `room_unavailable`, and `unsupported_version`.

An unavailable random room and an occupied Receiver slot both use `room_unavailable`.

## Pairing and ephemeral key agreement

A pairing link is `https://keybridge.example/#room=<roomId>&key=<roomKey>`. The room key is 32 random bytes in base64url form. The browser removes the fragment after import.

The PIN contains eight characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. Presentation can insert one hyphen. HKDF-SHA-256 derives the AES-256-GCM pairing key with these inputs:

- input key material: the 32-byte room key;
- salt: UTF-8 for `<roomId>:<normalizedPIN>`;
- info: UTF-8 for `keybridge-v2/pairing`.

The pairing key authenticates an ephemeral P-256 Elliptic Curve Diffie-Hellman (ECDH) exchange. The pairing key does not contribute key material to the session root.

The Receiver creates an ephemeral P-256 key pair when it submits the PIN. The encrypted pair request contains a random `receiverNonce` and the raw uncompressed Receiver public key. The public key is 65 bytes before base64url encoding.

The Sender creates an ephemeral P-256 key pair after it authenticates the request. The encrypted approval contains these fields:

- `approved: true`;
- the Receiver nonce and public key from the request;
- a random `senderNonce`;
- the raw uncompressed Sender public key.

The Receiver rejects an approval if a Receiver field differs from its request.

Both browsers encode the transcript as UTF-8 JSON without whitespace:

```text
[2,"keybridge-v2/session",roomId,receiverNonce,receiverPublicKey,senderNonce,senderPublicKey]
```

Each browser computes the 256-bit P-256 ECDH shared secret. SHA-256 hashes the transcript. HKDF-SHA-256 derives a 32-byte session root with the transcript hash as salt and `keybridge-v2/session-root` as info.

HKDF-SHA-256 derives three 32-byte chain keys from the session root and transcript hash:

- `keybridge-v2/chain/sender-item`;
- `keybridge-v2/chain/sender-control`;
- `keybridge-v2/chain/receiver-control`.

The browser removes references to the ECDH private key and shared secret after it creates the chains. JavaScript does not guarantee physical memory erasure.

## Symmetric ratchet

Each chain starts at generation zero. An item uses the Sender item chain. A Sender revocation uses the Sender control chain. A Receiver revocation uses the Receiver control chain.

For generation `n`, HKDF-SHA-256 uses the current 32-byte chain key and the UTF-8 room identifier as salt. The message-key info is `keybridge-v2/ratchet/<channel>/message/<n>`. The next-chain info is `keybridge-v2/ratchet/<channel>/next/<n>`.

The message derivation produces a non-extractable AES-256-GCM key. The next-chain derivation produces the next 32-byte chain key. The sender saves the next chain before it transmits the envelope. The sender does not roll back a chain after a rejected command.

A receiver derives future generations in temporary state. The receiver saves the new state only after AES-GCM authentication and body validation succeed. A receiver accepts a forward gap of at most 32 generations. It keeps at most 32 keys for missing, unprocessed generations and removes each key after use. A skipped key expires five minutes after derivation.

Envelope generations range from 0 through 4095. A chain state can contain generation 4096 after it processes the last valid envelope.

## Encrypted envelope version 2

```json
{
  "version": 2,
  "roomId": "base64url",
  "messageId": "base64url",
  "direction": "sender-to-receiver",
  "kind": "item",
  "expiresAt": 1700000000000,
  "generation": 0,
  "nonce": "16-character-base64url",
  "ciphertext": "base64url"
}
```

The AES-GCM additional authenticated data is UTF-8 JSON for this tuple:

```text
[version,roomId,messageId,direction,kind,expiresAt,generation,nonce]
```

The encrypted body duplicates `roomId`, `messageId`, `direction`, `kind`, `expiresAt`, and `generation`. The browser rejects a mismatch.

Pairing envelopes use a null generation. Item and control envelopes use an integer generation. Pairing envelopes have a null expiration. Item envelopes have an expiration. Control envelopes have a null expiration.

Directions remain `sender-to-receiver` and `receiver-to-sender`. Kinds remain `pair-request`, `pair-response`, `item`, and `control`.

## Persistence and reload

The browser stores one phase-specific version 3 record in `sessionStorage`. A pending Receiver record contains its PKCS#8 private key. The browser deletes that private key after approval.

A paired record contains current chains, bounded skipped keys, and exact encrypted commands that await a Relay result. A Sender record also keeps the room key and PIN for Receiver reset. A Receiver record deletes the room key and PIN after approval. Neither record contains item plaintext or processed message keys.

After a reload, the browser ignores retained envelopes from processed generations. The user sees only items that the browser processes after the reload.

## Security properties and limits

Disclosure of the link, PIN, retained traffic, and a current chain key does not reveal deleted message keys. This property depends on ECDH hardness, HKDF-SHA-256, AES-256-GCM, and deletion of old logical state.

A current chain key reveals its current and future generations. The protocol does not provide post-compromise recovery. Skipped keys can decrypt their missing, unprocessed envelopes until the browser uses or expires those keys.

The protocol does not protect endpoint plaintext, an in-progress handshake, compromised JavaScript, or browser storage. The PIN still permits offline guesses against captured pairing ciphertext. P-256 is not resistant to a future cryptographically relevant quantum computer.
