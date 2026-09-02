import { isIP } from 'node:net';

const RATE_WINDOW_MS = 600_000;

export function addressGroup(address: string): string {
  const clean = address.replace(/^::ffff:/, '').split('%')[0] ?? '';
  if (isIP(clean) === 4) {
    return clean;
  }

  if (isIP(clean) === 6) {
    const [leftText, rightText] = clean.toLowerCase().split('::');
    const left = leftText ? leftText.split(':') : [];
    const right = rightText ? rightText.split(':') : [];
    const missing = 8 - left.length - right.length;
    const parts = rightText === undefined ? left : [...left, ...Array(missing).fill('0'), ...right];
    const prefix = parts.slice(0, 4).map((part) => Number.parseInt(part || '0', 16).toString(16));
    return `${prefix.join(':')}::/64`;
  }

  return 'unknown';
}

interface Entry {
  connections: number;
  rooms: number[];
  pendingAttempts: number[];
}

export class RateLimiter {
  readonly #entries = new Map<string, Entry>();

  canConnect(group: string): boolean {
    return (this.#entries.get(group)?.connections ?? 0) < 20;
  }

  connect(group: string): void {
    const entry = this.#get(group);
    entry.connections += 1;
  }

  disconnect(group: string): void {
    const entry = this.#entries.get(group);
    if (entry) {
      entry.connections = Math.max(0, entry.connections - 1);
    }
  }

  canCreate(group: string, live: number, now: number): 'ok' | 'rate_limited' {
    const entry = this.#get(group);
    entry.rooms = recent(entry.rooms, now);
    return live >= 5 || entry.rooms.length >= 20 ? 'rate_limited' : 'ok';
  }

  created(group: string, now: number): void {
    this.#get(group).rooms.push(now);
  }

  canAttemptPairing(group: string, now: number): boolean {
    const entry = this.#get(group);
    entry.pendingAttempts = recent(entry.pendingAttempts, now);
    if (entry.pendingAttempts.length >= 20) {
      return false;
    }

    entry.pendingAttempts.push(now);
    return true;
  }

  cleanup(now: number): void {
    for (const [key, entry] of this.#entries) {
      entry.rooms = recent(entry.rooms, now);
      entry.pendingAttempts = recent(entry.pendingAttempts, now);
      if (
        entry.connections === 0 &&
        entry.rooms.length === 0 &&
        entry.pendingAttempts.length === 0
      ) {
        this.#entries.delete(key);
      }
    }
  }

  #get(group: string): Entry {
    const existing = this.#entries.get(group);
    if (existing) {
      return existing;
    }

    const entry = { connections: 0, rooms: [], pendingAttempts: [] };
    this.#entries.set(group, entry);
    return entry;
  }
}

function recent(times: number[], now: number): number[] {
  return times.filter((time) => now - time < RATE_WINDOW_MS);
}
