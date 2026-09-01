import { isIP } from 'node:net';
export function addressGroup(address:string):string {const clean=address.replace(/^::ffff:/,'').split('%')[0]??'';if(isIP(clean)===4)return clean;if(isIP(clean)===6){const parts=clean.split(':');return `${parts.slice(0,4).join(':')}::/64`}return 'unknown'}
interface Entry { connections:number; rooms:number[] }
export class RateLimiter {
 readonly #entries=new Map<string,Entry>();
 canConnect(group:string):boolean {return (this.#entries.get(group)?.connections??0)<20}
 connect(group:string):void {const e=this.#get(group);e.connections++}
 disconnect(group:string):void {const e=this.#entries.get(group);if(e)e.connections=Math.max(0,e.connections-1)}
 canCreate(group:string,live:number,now:number):'ok'|'rate_limited' {const e=this.#get(group);e.rooms=e.rooms.filter(time=>now-time<600_000);return live>=5||e.rooms.length>=20?'rate_limited':'ok'}
 created(group:string,now:number):void {this.#get(group).rooms.push(now)}
 cleanup(now:number):void {for(const [key,e] of this.#entries){e.rooms=e.rooms.filter(t=>now-t<600_000);if(!e.connections&&!e.rooms.length)this.#entries.delete(key)}}
 #get(group:string):Entry {let e=this.#entries.get(group);if(!e){e={connections:0,rooms:[]};this.#entries.set(group,e)}return e}
}
