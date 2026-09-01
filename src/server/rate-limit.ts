import { isIP } from 'node:net';
export function addressGroup(address: string): string {
  const clean = address.replace(/^::ffff:/, '').split('%')[0] ?? '';
  if (isIP(clean) === 4) return clean;
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
    const e = this.#get(group);
    e.connections++;
  }
  disconnect(group: string): void {
    const e = this.#entries.get(group);
    if (e) e.connections = Math.max(0, e.connections - 1);
  }
  canCreate(group: string, live: number, now: number): 'ok' | 'rate_limited' {
    const e = this.#get(group);
    e.rooms = e.rooms.filter((time) => now - time < 600_000);
    return live >= 5 || e.rooms.length >= 20 ? 'rate_limited' : 'ok';
  }
  created(group: string, now: number): void {
    this.#get(group).rooms.push(now);
  }
  canAttemptPairing(group: string, now: number): boolean {
    const entry = this.#get(group);
    entry.pendingAttempts = entry.pendingAttempts.filter((time) => now - time < 600_000);
    if (entry.pendingAttempts.length >= 20) return false;
    entry.pendingAttempts.push(now);
    return true;
  }
  cleanup(now: number): void {
    for (const [key, entry] of this.#entries) {
      entry.rooms = entry.rooms.filter((time) => now - time < 600_000);
      entry.pendingAttempts = entry.pendingAttempts.filter((time) => now - time < 600_000);
      if (!entry.connections && !entry.rooms.length && !entry.pendingAttempts.length)
        this.#entries.delete(key);
    }
  }
  #get(group: string): Entry {
    let e = this.#entries.get(group);
    if (!e) {
      e = { connections: 0, rooms: [], pendingAttempts: [] };
      this.#entries.set(group, e);
    }
    return e;
  }
}
