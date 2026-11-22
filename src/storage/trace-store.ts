import type {TraceEvent} from '../core/response-tracing/metrics.js';
import type {Database} from 'better-sqlite3';
import type {ConnectionScope} from '../contracts/index.js';
import type {Connection} from './connection.js';
import type {LifecycleBackend} from './lifecycle-store.js';
import type {TraceConfig} from '../core/response-tracing/config.js';
import type {TracePayload,TraceRecord,TracePublication} from './trace-types.js';
import type {QueueWork} from './queue-types.js';
import {encodeTrace} from './trace-validation.js';
import {requireInput,timestamp} from './validation.js';
export function initialTrace(route:TracePayload['route']=null):TracePayload {return {model:{name:null,invoked:'no'},prompt:null,context:null,summary:null,route,resultKind:null,preparationFailure:null,publication:{rowId:'silent_outcome',tableVersion:1,reaction:'silence',status:'pending_checks',reason:'none'},degraded:false,degradation:'none',tools:[]};}
export function minimalTrace(p:TracePayload,reason:'write_failed'|'size_exceeded'):TracePayload {
 return {...p,context:null,tools:[],degraded:true,degradation:reason};
}
function immutable<T>(value:T):T {if(value&&typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;}
export function traceRecord(db:Database,scope:ConnectionScope,id:number|undefined,now=Date.now()):TraceRecord|null {
 const r=db.prepare(`SELECT job_id AS jobId,message_id AS messageId,generation,started_at AS startedAt,finished_at AS finishedAt,expires_at AS expiresAt,outcome,payload FROM response_traces WHERE chat_id=? AND generation=? AND expires_at>? ${id===undefined?'ORDER BY job_id DESC LIMIT 1':'AND job_id=?'}`).get(...(id===undefined?[scope.chatId,scope.generation,now]:[scope.chatId,scope.generation,now,id])) as (Omit<TraceRecord,'payload'>&{payload:string})|undefined;
 return r?immutable({...r,payload:JSON.parse(r.payload) as TracePayload}):null;
}
export function startTrace(db:Database,w:QueueWork,c:Pick<TraceConfig,'maxRecordBytes'|'retentionDays'>,now=Date.now()) {db.prepare('INSERT INTO response_traces(job_id,chat_id,generation,message_id,started_at,expires_at,payload) VALUES(?,?,?,?,?,?,?)').run(w.id,w.scope.chatId,w.scope.generation,w.messageId,now,now+c.retentionDays*86400000,encodeTrace(initialTrace(w.route),c.maxRecordBytes));}
export function createTraceBackend(connection:Connection,lifecycle:LifecycleBackend){
 let config:Pick<TraceConfig,'maxRecordBytes'|'retentionDays'>={maxRecordBytes:65536,retentionDays:7};
 let report:(event:TraceEvent)=>void=()=>{};
 return {
  observe(fn:(event:TraceEvent)=>void){report=fn;},report(event:TraceEvent){report(event);},
  configure(c:TraceConfig){config=c;},config(){return config;},
  get(scope:ConnectionScope,id?:number){if(id!==undefined)requireInput(Number.isSafeInteger(id)&&id>0);return lifecycle.transaction(scope,db=>traceRecord(db,scope,id));},
  prune(scope:ConnectionScope,now:number,limit=100){timestamp(now);requireInput(Number.isSafeInteger(limit)&&limit>0&&limit<=1000);return lifecycle.transaction(scope,db=>{const deleted=db.prepare('DELETE FROM response_traces WHERE job_id IN (SELECT job_id FROM response_traces WHERE chat_id=? AND generation=? AND expires_at<=? LIMIT ?)').run(scope.chatId,scope.generation,now,limit).changes;return {deleted,more:!!db.prepare('SELECT 1 FROM response_traces WHERE chat_id=? AND generation=? AND expires_at<=? LIMIT 1').get(scope.chatId,scope.generation,now)};});},
  update(scope:ConnectionScope,id:number,payload:TracePayload){return lifecycle.transaction(scope,db=>{const json=encodeTrace(payload,config.maxRecordBytes);return db.prepare('UPDATE response_traces SET payload=? WHERE job_id=? AND chat_id=? AND generation=?').run(json,id,scope.chatId,scope.generation).changes===1;});},
  publication(scope:ConnectionScope,id:number,pub:TracePublication){return lifecycle.transaction(scope,db=>{const row=db.prepare('SELECT payload FROM response_traces WHERE job_id=? AND chat_id=? AND generation=? AND finished_at IS NOT NULL').get(id,scope.chatId,scope.generation) as {payload:string}|undefined;if(!row)return false;const p=JSON.parse(row.payload) as TracePayload;const json=encodeTrace({...p,publication:pub},config.maxRecordBytes);return db.prepare('UPDATE response_traces SET payload=? WHERE job_id=?').run(json,id).changes===1;});},
 };
}
export type TraceBackend=ReturnType<typeof createTraceBackend>;
const backends=new WeakMap<object,TraceBackend>();
export function registerTraces(s:object,b:TraceBackend){backends.set(s,b);}
export function traceBackend(s:object):TraceBackend {const b=backends.get(s);if(!b)throw new TypeError('Tracing: unavailable');return b;}
