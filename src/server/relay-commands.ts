import { Buffer } from 'node:buffer';
import {
  MAX_ENVELOPE_BYTES,
  matchesEnvelope,
  type Direction,
  type EncryptedEnvelope,
  type EnvelopeKind,
} from '../shared/envelope.js';
import type { ClientFrame, Role, ServerFrame } from '../shared/protocol.js';
import type { Room } from './rooms.js';

type WithoutVersion<T> = T extends { version: number } ? Omit<T, 'version'> : never;
export type ServerPayload = WithoutVersion<ServerFrame>;

type ActiveCommand = Exclude<ClientFrame, { type: 'create' | 'join' | 'resume' }>;

export type RelayEffect =
  | { type: 'reply'; message: ServerPayload }
  | { type: 'send'; role: Role; message: ServerPayload }
  | { type: 'notify'; except?: Role; message: ServerPayload }
  | { type: 'close_self'; code: number; reason: string }
  | { type: 'end'; reason: string };

export function dispatchRoomCommand(
  room: Room,
  role: Role,
  message: ActiveCommand,
  now: number,
): RelayEffect[] {
  const cached = room.requestResult(role, message.requestId);
  if (cached !== undefined) {
    return [{ type: 'reply', message: cached as ServerPayload }];
  }

  room.ensureCommandCapacity();

  switch (message.type) {
    case 'pair':
      requireRole(role, 'receiver');
      validateEnvelope(message.envelope, room, 'receiver-to-sender', 'pair-request', 'null');
      room.recordPairFrame(message.envelope);
      return complete(
        room,
        role,
        message.requestId,
        { type: 'ack', requestId: message.requestId },
        [
          {
            type: 'send',
            role: 'sender',
            message: {
              type: 'pair_request',
              envelope: message.envelope,
              requestId: message.requestId,
            },
          },
        ],
      );

    case 'approve':
      requireRole(role, 'sender');
      validateEnvelope(message.envelope, room, 'sender-to-receiver', 'pair-response', 'null');
      room.approve(message.envelope, now);
      return complete(
        room,
        role,
        message.requestId,
        { type: 'ack', requestId: message.requestId, status: room.status() },
        [
          {
            type: 'send',
            role: 'receiver',
            message: {
              type: 'approved',
              envelope: message.envelope,
              requestId: message.requestId,
            },
          },
        ],
      );

    case 'reject':
      requireRole(role, 'sender');
      room.reject(now);
      return complete(
        room,
        role,
        message.requestId,
        { type: 'ack', requestId: message.requestId, status: room.status() },
        [{ type: 'send', role: 'receiver', message: { type: 'rejected' } }],
      );

    case 'item': {
      requireRole(role, 'sender');
      const envelope = message.envelope;
      validateEnvelope(envelope, room, 'sender-to-receiver', 'item', 'present');

      if (
        envelope.expiresAt === null ||
        envelope.expiresAt <= now ||
        envelope.expiresAt > now + 301_000
      ) {
        throw new Error('invalid_message');
      }

      const bytes = Buffer.byteLength(JSON.stringify(envelope));
      room.store(envelope, bytes, now);
      return complete(
        room,
        role,
        message.requestId,
        { type: 'ack', requestId: message.requestId, status: room.status() },
        [{ type: 'send', role: 'receiver', message: { type: 'item', envelope } }],
      );
    }

    case 'revoke': {
      const direction = role === 'sender' ? 'sender-to-receiver' : 'receiver-to-sender';
      validateEnvelope(message.envelope, room, direction, 'control', 'null');
      room.revoke(message.itemId);
      const otherRole = role === 'sender' ? 'receiver' : 'sender';
      return complete(
        room,
        role,
        message.requestId,
        { type: 'ack', requestId: message.requestId },
        [
          {
            type: 'send',
            role: otherRole,
            message: {
              type: 'revoked',
              itemId: message.itemId,
              envelope: message.envelope,
            },
          },
        ],
      );
    }

    case 'extend':
      requireRole(role, 'sender');
      room.extend(now);
      return complete(
        room,
        role,
        message.requestId,
        { type: 'ack', requestId: message.requestId, status: room.status() },
        [{ type: 'notify', message: { type: 'room_state', status: room.status() } }],
      );

    case 'end': {
      requireRole(role, 'sender');
      const response: ServerPayload = { type: 'ack', requestId: message.requestId };
      room.completeRequest(role, message.requestId, response);
      return [
        { type: 'reply', message: response },
        { type: 'end', reason: 'ended' },
      ];
    }

    case 'leave':
      requireRole(role, 'receiver');
      room.disconnect('receiver', now);
      return [
        {
          type: 'notify',
          except: 'receiver',
          message: { type: 'room_state', status: room.status() },
        },
        { type: 'close_self', code: 1000, reason: 'left' },
      ];
  }
}

function complete(
  room: Room,
  role: Role,
  requestId: string,
  response: ServerPayload,
  effects: RelayEffect[] = [],
): RelayEffect[] {
  room.completeRequest(role, requestId, response);
  return [...effects, { type: 'reply', message: response }];
}

function requireRole(actual: Role, expected: Role): void {
  if (actual !== expected) {
    throw new Error('not_allowed');
  }
}

function validateEnvelope(
  envelope: EncryptedEnvelope,
  room: Room,
  direction: Direction,
  kind: EnvelopeKind,
  expiresAt: 'null' | 'present',
): void {
  if (
    Buffer.byteLength(JSON.stringify(envelope)) > MAX_ENVELOPE_BYTES ||
    !matchesEnvelope(envelope, { roomId: room.id, direction, kind, expiresAt })
  ) {
    throw new Error('invalid_message');
  }
}
