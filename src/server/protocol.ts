import { isEnvelope, PROTOCOL_VERSION } from '../shared/envelope.js';
export type ClientMessage =
 | {version:1;type:'create';roomId:string;requestId:string}
 | {version:1;type:'join';roomId:string;requestId:string}
 | {version:1;type:'resume';roomId:string;role:'sender'|'receiver';credential:string;requestId:string}
 | {version:1;type:'pair';envelope:unknown;requestId:string}
 | {version:1;type:'approve';envelope:unknown;requestId:string}
 | {version:1;type:'reject'|'extend'|'end'|'leave';requestId:string}
 | {version:1;type:'item';envelope:unknown;requestId:string}
 | {version:1;type:'revoke';itemId:string;requestId:string}
 | {version:1;type:'pong'};
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{16,64}$/.test(v);
export function parseMessage(text:string):ClientMessage|null {let v:unknown;try{v=JSON.parse(text)}catch{return null}if(!v||typeof v!=='object')return null;const m=v as Record<string,unknown>;if(m.version!==PROTOCOL_VERSION||typeof m.type!=='string')return null;if(m.type==='pong')return m as ClientMessage;if(!id(m.requestId))return null;if(['create','join'].includes(m.type)&&id(m.roomId))return m as ClientMessage;if(m.type==='resume'&&id(m.roomId)&&['sender','receiver'].includes(String(m.role))&&id(m.credential))return m as ClientMessage;if(['pair','approve','item'].includes(m.type)&&isEnvelope(m.envelope))return m as ClientMessage;if(['reject','extend','end','leave'].includes(m.type))return m as ClientMessage;if(m.type==='revoke'&&id(m.itemId))return m as ClientMessage;return null}
