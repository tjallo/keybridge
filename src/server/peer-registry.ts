import type { WebSocket } from 'ws';
import type { Role } from '../shared/protocol.js';
import type { Room } from './rooms.js';

export interface Peer {
  readonly socket: WebSocket;
  readonly group: string;
  room: Room | null;
  role: Role | null;
  alive: boolean;
  commandTimes: number[];
  intentional: boolean;
  roleTimer: NodeJS.Timeout | null;
}

type RoomPeers = Partial<Record<Role, Peer>>;

export class PeerRegistry {
  readonly #rooms = new Map<string, RoomPeers>();

  attach(peer: Peer, room: Room, role: Role): Peer | undefined {
    const peers = this.#rooms.get(room.id) ?? {};
    const replaced = peers[role];

    peer.room = room;
    peer.role = role;
    peers[role] = peer;
    this.#rooms.set(room.id, peers);

    return replaced === peer ? undefined : replaced;
  }

  current(roomId: string, role: Role): Peer | undefined {
    return this.#rooms.get(roomId)?.[role];
  }

  isCurrent(peer: Peer): boolean {
    return Boolean(peer.room && peer.role && this.#rooms.get(peer.room.id)?.[peer.role] === peer);
  }

  removeIfCurrent(peer: Peer): boolean {
    if (!peer.room || !peer.role) {
      return false;
    }

    const peers = this.#rooms.get(peer.room.id);
    if (peers?.[peer.role] !== peer) {
      return false;
    }

    delete peers[peer.role];
    if (!peers.sender && !peers.receiver) {
      this.#rooms.delete(peer.room.id);
    }

    return true;
  }

  peersFor(roomId: string): Peer[] {
    return Object.values(this.#rooms.get(roomId) ?? {});
  }

  *all(): Iterable<Peer> {
    for (const peers of this.#rooms.values()) {
      if (peers.sender) {
        yield peers.sender;
      }
      if (peers.receiver) {
        yield peers.receiver;
      }
    }
  }

  deleteRoom(roomId: string): void {
    this.#rooms.delete(roomId);
  }
}
