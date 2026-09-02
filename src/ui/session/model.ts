import type { Role, RoomState } from '../../shared/protocol.js';

export type View = 'start' | 'sender' | 'receiver' | 'security';
export type ConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'terminal';
export type ReceiverView = 'PIN' | 'PENDING' | 'PAIRED' | 'REJOINING';

export interface Item {
  id: string;
  label: string;
  value: string;
  createdAt: number;
  expiresAt: number;
  ttl: number;
}

export interface SessionSnapshot {
  view: View;
  role: Role | null;
  connection: ConnectionState;
  roomId: string;
  link: string;
  pin: string;
  roomState: RoomState;
  receiverView: ReceiverView;
  deadline: number;
  error: string;
  canApprove: boolean;
  items: Item[];
}

export type ConnectionEvent =
  | { type: 'connect' }
  | { type: 'ready' }
  | { type: 'lost' }
  | { type: 'terminal'; message: string }
  | { type: 'close' };

export function initialSessionSnapshot(): SessionSnapshot {
  return {
    view: 'start',
    role: null,
    connection: 'disconnected',
    roomId: '',
    link: '',
    pin: '',
    roomState: 'WAITING',
    receiverView: 'PIN',
    deadline: 0,
    error: '',
    canApprove: false,
    items: [],
  };
}

export function reduceConnection(
  snapshot: SessionSnapshot,
  event: ConnectionEvent,
): SessionSnapshot {
  switch (event.type) {
    case 'connect':
      return {
        ...snapshot,
        connection:
          snapshot.connection === 'connected' || snapshot.connection === 'reconnecting'
            ? 'reconnecting'
            : 'connecting',
      };
    case 'ready':
      return { ...snapshot, connection: 'connected' };
    case 'lost':
      return { ...snapshot, connection: 'reconnecting' };
    case 'terminal':
      return { ...snapshot, connection: 'terminal', error: event.message };
    case 'close':
      return { ...snapshot, connection: 'disconnected' };
  }
}

export function roomActionsEnabled(snapshot: SessionSnapshot): boolean {
  return snapshot.connection === 'connected';
}
