# KeyBridge protocol v1

Protocol version **1 is frozen**. Browser and Relay frames are bounded JSON text; binary frames are unsupported. A first frame is `create`, `join`, or `resume`. Every mutation includes a random `requestId`; repeated identifiers are acknowledged without repeating the mutation.

## Pairing capability

A pairing link is `https://keybridge.tjallo.nl/#room=<22-character base64url room identifier>&key=<43-character base64url room key>`. The fragment is removed immediately after import. The PIN is eight characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`; presentation may insert one hyphen. HKDF-SHA-256 derives the AES-256-GCM pairing key with:

- input key material: the 32-byte room key;
- salt UTF-8: `<roomId>:<normalizedPIN>`;
- info UTF-8: `keybridge-v1/pairing`.

The encrypted Receiver request contains a random `receiverNonce`. The encrypted Sender approval contains that nonce and a random `senderNonce`. A session root is HKDF over the pairing-key bytes, salt `<roomId>/<receiverNonce>/<senderNonce>`, and info `keybridge-v1/session-root`. Three keys use room ID salt and these info strings:

- `keybridge-v1/sender-to-receiver/item`
- `keybridge-v1/sender-to-receiver/control`
- `keybridge-v1/receiver-to-sender/control`

## Envelope

```json
{
  "version": 1,
  "roomId": "base64url",
  "messageId": "base64url",
  "direction": "sender-to-receiver",
  "kind": "item",
  "expiresAt": 1700000000000,
  "nonce": "16-char-base64url",
  "ciphertext": "base64url"
}
```

The AES-GCM additional authenticated data is UTF-8 JSON for this fixed tuple, with no whitespace:

```text
[version, roomId, messageId, direction, kind, expiresAt, nonce]
```

Directions are `sender-to-receiver` and `receiver-to-sender`. Kinds are `pair-request`, `pair-response`, `item`, and `control`. Pairing envelopes have a null expiration. Bodies duplicate `roomId`, `messageId`, `direction`, `kind`, and `expiresAt`; a mismatch is rejected. Nonces are 96 random bits. Identifiers are replay-checked.

## Commands and events

Commands: `create`, `join`, `resume`, `pair`, `approve`, `reject`, `extend`, `end`, `leave`, `item`, `revoke`, and `pong`. Events: `created`, `joined`, `resumed`, `pair_request`, `approved`, `rejected`, `item`, `revoked`, `room_state`, `room_ended`, `ack`, and `error`.

Stable public errors are `busy`, `expired`, `invalid_message`, `not_allowed`, `rate_limited`, `room_unavailable`, and `unsupported_version`. An unavailable random room and a busy receiver slot both use `room_unavailable`.

Frames are below 96 KiB. An encrypted envelope is at most 72 KiB. Item TTL is 30, 60, 120, or 300 seconds. Relay credentials are random role-specific capabilities and are never part of encrypted payload key derivation.
