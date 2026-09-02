# KeyBridge transport protocol version 2

Transport protocol version 2 defines the JSON frames between each browser and the Relay. It uses encrypted envelope version 1 without changes. See [protocol version 1](protocol-v1.md) for the archived transport protocol and the envelope key schedule.

The Relay accepts bounded JSON text frames on `/ws`. The Relay rejects binary frames. Each frame contains `"version": 2` and a `type` field.

## Identifiers and credentials

A room identifier is a 22-character base64url value. A request identifier is a 16-to-64-character base64url value.

Each browser generates a 32-byte random role credential before its first connection. Base64url encoding produces 43 characters. The browser stores the credential in `sessionStorage`. The pairing link and encrypted payloads do not contain the credential.

The Relay treats the credential as a capability for one role. A connection with the correct credential can replace an older connection for that role. The Relay closes the older connection with code `4002` and reason `replaced`.

## First command

The first command on a socket is `create`, `join`, or `resume`.

A Sender creates a room:

```json
{
  "version": 2,
  "type": "create",
  "roomId": "base64url",
  "credential": "43-character-base64url",
  "requestId": "base64url"
}
```

A Receiver reserves the room:

```json
{
  "version": 2,
  "type": "join",
  "roomId": "base64url",
  "credential": "43-character-base64url",
  "requestId": "base64url"
}
```

A connected role resumes a room:

```json
{
  "version": 2,
  "type": "resume",
  "roomId": "base64url",
  "role": "sender",
  "credential": "43-character-base64url",
  "requestId": "base64url"
}
```

`create` and `join` are idempotent for the same room, role, and credential. This rule recovers a session when the Relay accepted the first command but the browser did not receive the response.

The Relay responds with `ready`:

```json
{
  "version": 2,
  "type": "ready",
  "requestId": "base64url",
  "mode": "resumed",
  "snapshot": {
    "state": "PAIRED",
    "deadline": 1700000000000,
    "senderConnected": true,
    "receiverConnected": true,
    "items": [],
    "pairing": null
  }
}
```

`mode` is `created`, `joined`, or `resumed`. The `pairing` field contains the encrypted pairing request needed by the Sender or the encrypted approval needed by the Receiver. The field is null when the role needs no pairing frame.

## Room lifecycle

The public room states are:

- `WAITING`: The room can reserve one Receiver.
- `PAIR_PENDING`: The Relay received one encrypted pairing request from the reserved Receiver.
- `PAIRED`: The Sender approved the Receiver.
- `SENDER_GRACE`: The Sender connection is absent during its reconnect grace period.
- `RECEIVER_GRACE`: The reserved or paired Receiver is absent during its reconnect grace period.

Each role has an independent 60-second reconnect grace period. Sender grace expiry ends the room. Receiver grace expiry removes retained items and returns the room to `WAITING`. A pending pairing request also expires after 60 seconds. A room expires 10 minutes after creation or its last accepted item or extension.

The Relay sends a `room_state` event after a visible lifecycle change:

```json
{
  "version": 2,
  "type": "room_state",
  "status": {
    "state": "RECEIVER_GRACE",
    "deadline": 1700000000000,
    "senderConnected": true,
    "receiverConnected": false
  }
}
```

## Commands and events

Commands after attachment are `pair`, `approve`, `reject`, `item`, `revoke`, `extend`, `end`, and `leave`. Each command contains a random `requestId`.

The Relay sends these events:

- `pair_request` sends an encrypted Receiver pairing request to the Sender.
- `approved` sends an encrypted Sender approval to the Receiver.
- `rejected` tells the Receiver that the Sender rejected the request.
- `item` sends an encrypted item to the Receiver.
- `revoked` sends an authenticated encrypted revocation to the other role.
- `ack` confirms a completed command.
- `room_state` reports a lifecycle change.
- `room_ended` reports a terminal room reason.
- `error` reports a public protocol error.

The Relay caches completed command responses by role and `requestId`. A repeated identifier from the same role receives the original response without repeating the effect. The other role can use the same identifier without a collision.

The Relay retains encrypted items until item expiry, revocation, Receiver grace expiry, or room end. It also retains the encrypted pairing frames needed for a resume snapshot. The Relay does not receive the keys or plaintext.

## Reconnect behavior

A browser reconnects with bounded backoff after an unintentional socket close. It reuses the role credential and sends `resume`. The browser replays unresolved idempotent commands with their original request identifiers after `ready`.

A browser stops reconnecting after the grace deadline, a terminal error, explicit leave, explicit room end, or session replacement. Browser timer throttling can delay an attempt. Online and visibility events request an immediate attempt when the browser resumes execution.

## Encrypted envelope version 1

Transport version 2 uses the frozen version 1 encrypted envelope. The envelope still contains `"version": 1`. The HKDF-SHA-256 key schedule, AES-256-GCM additional authenticated data, directions, kinds, and test vectors do not change.

See [protocol version 1](protocol-v1.md) for the pairing link, PIN alphabet, key derivation inputs, and envelope tuple.

## Limits and errors

Frames are below 96 KiB. Encrypted envelopes are at most 72 KiB. Item plaintext is at most 64 KiB. A room retains at most 10 items and 256 KiB of encrypted item data. Item time-to-live values are 30, 60, 120, or 300 seconds.

Public error codes are `busy`, `expired`, `invalid_message`, `not_allowed`, `rate_limited`, `room_unavailable`, and `unsupported_version`. An unavailable random room and an occupied Receiver slot both use `room_unavailable`.
