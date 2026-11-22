import { acceptsHistoryInput, applyHistoryRetention, historySourcesVisible, pruneHistoryMessages } from './history-retention-store.js';
import {initialTrace,startTrace,minimalTrace} from './trace-store.js';
import type {TraceBackend} from './trace-store.js';
import type {TracePayload} from './trace-types.js';
import {encodeTrace} from './trace-validation.js';
import { createChatStore } from './chats.js';
import type { RoutedQueueCallback, RoutedAdmission, RouteMetadata } from './queue-types.js';
import { createMessageStore, readMessage, validateMessage } from './messages.js';
import type { MessageInput } from './types.js';
import type { QueueConfig, QueueDecision, QueueAdmission } from './queue-types.js';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index.js';
import type { Connection } from './connection.js';
import type { LifecycleBackend } from './lifecycle-store.js';
import type { QueueWork, QueueOutcome, QueueRecord } from './queue-types.js';
import { StorageError } from './errors.js';
import { requireInput, timestamp } from './validation.js';
import { readChatControl } from './chat-control-store.js';
import { admitRequestQuota, pruneRequestQuota } from './request-quota-store.js';
import { createAutonomousQuotaStore, pruneAutonomousQuota, restoreAutonomousQuota } from './autonomous-quota-store.js';
import type { ChatLimits } from '../core/chat-limits/config.js';
export function createQueueBackend(connection: Connection, lifecycle: LifecycleBackend,traces:TraceBackend,messageRetentionDays?:number) {
  const retentionMs=messageRetentionDays===undefined?undefined:messageRetentionDays*86_400_000;
  const sources = new WeakMap<QueueWork, readonly number[]>();
  const runningRevisions = new WeakMap<QueueWork, number>();
  function owned(db: Database, token: string) {
    const row = db.prepare('SELECT token,expires_at AS expires FROM queue_lease WHERE singleton=1').get() as {token:string|null;expires:number};
    if (row.token !== token || row.expires <= Date.now()) throw new StorageError('queue_lost_ownership');
  }
  function transaction<T>(token: string, operation: (db: Database) => T): T {
    return connection.run(db => db.transaction(() => { owned(db, token); const result = operation(db); owned(db, token); return result; }).immediate());
  }
  function currentWork(db: Database, work: QueueWork): boolean {
    const expected = runningRevisions.get(work);
    if (expected === undefined) return false;
    try {
      if (lifecycle.assertScope(db, work.scope).revision !== expected) return false;
      if (!work.route) return true;
      return readChatControl(db,work.scope.chatId).responseRevision===(work.controlRevision??0);
    }
    catch (error) {
      if (error instanceof StorageError && (error.code === 'stale_scope' || error.code === 'uncertain_connection')) return false;
      throw error;
    }
  }
  function turn(db:Database, scope:{readonly chatId:string;readonly generation:number}) {
    const row=db.prepare('UPDATE queue_lease SET sequence=sequence+1 WHERE singleton=1 AND sequence<9007199254740991 RETURNING sequence').get() as {sequence:number}|undefined;
    if(!row)throw new StorageError('operation_failed');
    db.prepare('INSERT INTO queue_turns(chat_id,generation,served) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET served=excluded.served').run(scope.chatId,scope.generation,row.sequence);
  }
  function running(db: Database, token: string, work: QueueWork): boolean {
    return currentWork(db, work) && historySourcesVisible(db,work.scope.chatId,sources.get(work)??[work.messageId]) && !!db.prepare(`SELECT j.id FROM queue_jobs j
      JOIN chat_connections c ON c.chat_id=j.chat_id AND c.generation=j.generation
      LEFT JOIN chats s ON s.chat_id=j.chat_id
      WHERE j.id=? AND j.owner=? AND j.state='running' AND c.state='active'
        AND coalesce(s.enabled,1)=1 AND (j.route_kind IS NULL OR s.response_mode!='silent')`).get(work.id, token);
  }
  const messages = createMessageStore(connection);
  return {
    transaction,
    historyConfigured:retentionMs!==undefined,
    admitRouted(token:string,scope:ConnectionScope,message:MessageInput,decision:RoutedQueueCallback,config:QueueConfig,
      guard?: import('./queue-types.js').RoutedAdmissionGuard):RoutedAdmission {
     return transaction(token,()=>lifecycle.transaction(scope,db=>{
      const gate = guard?.();
      if (gate && !gate.journal) return {admission:{status:'paused'},decision:null};
      let chosen:import('./queue-types.js').RoutedQueueDecision|null=null;
      const admission=this.admit(token,scope,message,snapshot=>{
       const settings=createChatStore(connection).get(scope.chatId);requireInput(settings);
       const value:unknown=gate && !gate.respond ? {route:null,reason:'forbidden'} : decision(Object.freeze({...snapshot,settings:Object.freeze(settings)}));
       if(value instanceof Promise){void value.catch(()=>{});throw new StorageError('invalid_input');}
       requireInput(value!==null&&typeof value==='object');
       const routed=value as import('./queue-types.js').RoutedQueueDecision;
       requireInput(['direct_message','mention','reply','name','service','disabled','silent','sender_bot','sender_unknown','invalid_input','not_addressed','forbidden'].includes(routed.reason));
       if(routed.route!==null){requireInput(['direct_message','mention','reply','name'].includes(routed.route.kind)&&['normal','active'].includes(routed.route.mode)&&typeof routed.route.isGroupChat==='boolean'&&routed.reason===routed.route.kind);}
       const result:import('./queue-types.js').RoutedQueueDecision=gate?.ordinary===false&&routed.route
         ? {route:null,reason:'silent'} : routed;
       chosen=Object.freeze({reason:result.reason,route:result.route===null?null:Object.freeze({...result.route})});return chosen.route!==null;
      },config);
      const route=(chosen as import('./queue-types.js').RoutedQueueDecision|null)?.route;
      if(admission.status==='queued'&&route) {
        const revision=readChatControl(db,scope.chatId).responseRevision;
        db.prepare('UPDATE queue_jobs SET route_kind=?,route_mode=?,route_group=?,disclosure_version=?,control_revision=? WHERE id=?')
          .run(route.kind,route.mode,route.isGroupChat?1:0,gate?.version??null,revision,admission.jobId);
      }
      return Object.freeze({admission,decision:chosen});
     }));
    },
    admit(token: string, scope: ConnectionScope, message: MessageInput, decision: QueueDecision, config: QueueConfig): QueueAdmission {
      const snapshotMessage = {...message};
      requireInput(typeof decision === 'function');
      return transaction(token, () => lifecycle.transaction(scope, db => {
        requireInput(snapshotMessage.chatId === scope.chatId);
        const enabled = db.prepare('SELECT enabled FROM chats WHERE chat_id=?').get(scope.chatId) as {enabled:number}|undefined;
        requireInput(enabled?.enabled !== 0);
        validateMessage(snapshotMessage);
        if (!acceptsHistoryInput(db,scope,snapshotMessage)) return {status:'history_unavailable'};
        const appended = messages.append(snapshotMessage);
        if (appended.status === 'duplicate') return {status:'duplicate', messageId:appended.id};
        const now = Date.now(); const expires = now + config.maxQueueAgeMs; timestamp(expires);
        const snapshot = Object.freeze({message:Object.freeze(readMessage(db, scope.chatId, appended.id)!), receivedAt:now});
        const result: unknown = decision(snapshot);
        if (result instanceof Promise) { void result.catch(() => {}); throw new StorageError('invalid_input'); }
        requireInput(typeof result === 'boolean');
        if (!result) return {status:'not_needed',messageId:appended.id};
        const count = (chat: string | null) => (db.prepare("SELECT count(*) AS n FROM queue_jobs WHERE state='queued' AND expires_at>? AND (? IS NULL OR chat_id=?)").get(now,chat,chat) as {n:number}).n;
        if (count(null) >= config.maxQueuedTotal || count(scope.chatId) >= config.maxQueuedPerChat) return {status:'queue_full', messageId:appended.id};
        const pending=db.prepare("SELECT id FROM queue_jobs WHERE chat_id=? AND state IN ('queued','running') LIMIT 1").get(scope.chatId);
        if(!pending)turn(db,scope);
        const inserted=db.prepare("INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state) VALUES(?,?,?,?,?,'queued') RETURNING id").get(scope.chatId,scope.generation,appended.id,now,expires) as {id:number};
        return {status:'queued',messageId:appended.id,jobId:inserted.id};
      }));
    },
    acquire(token: string, leaseMs: number, safetyMs: number,config?:import('../core/response-tracing/config.js').TraceConfig,report?:(event:import('../core/response-tracing/metrics.js').TraceEvent)=>void,pausePlatform?:string) {
      requireInput(typeof token === 'string' && token.length > 0); timestamp(leaseMs); timestamp(safetyMs);
      return connection.run(db => db.transaction(() => {
        const now = Date.now(); timestamp(now + leaseMs);
        const row = db.prepare('SELECT token,expires_at AS expires FROM queue_lease WHERE singleton=1').get() as {token:string|null;expires:number};
        if (row.token !== null && row.expires > now) throw new StorageError('queue_owned');
        if(config)traces.configure(config);if(report)traces.observe(report);
        db.prepare('UPDATE queue_lease SET token=?,expires_at=?,safety_ms=? WHERE singleton=1').run(token, now + leaseMs, safetyMs);
        if (retentionMs!==undefined) applyHistoryRetention(db,retentionMs,now);
        restoreAutonomousQuota(db, pausePlatform === undefined ? null : `${pausePlatform}:`);
        if (pausePlatform !== undefined) lifecycle.pauseActivePlatform(db, pausePlatform);
        const running=db.prepare("SELECT j.id,j.chat_id AS chatId,j.generation,j.message_id AS messageId,j.received_at AS receivedAt FROM queue_jobs j WHERE j.state='running'").all() as {id:number;chatId:ConnectionScope['chatId'];generation:number;messageId:number;receivedAt:number}[];
        for(const row of running){
         const exists=db.prepare('SELECT payload FROM response_traces WHERE job_id=?').get(row.id) as {payload:string}|undefined;
         if(!exists){startTrace(db,{...row,scope:row as unknown as ConnectionScope,route:null},traces.config(),now);db.prepare('UPDATE response_traces SET payload=? WHERE job_id=?').run(encodeTrace({...initialTrace(),model:{name:null,invoked:'possible'},summary:null,degraded:true,degradation:'legacy_metadata_missing'},traces.config().maxRecordBytes),row.id);}
        }
        const open=db.prepare('SELECT job_id,payload FROM response_traces WHERE finished_at IS NULL').all() as {job_id:number;payload:string}[];
        for(const row of open){const payload=JSON.parse(row.payload) as TracePayload;db.prepare("UPDATE response_traces SET finished_at=max(started_at,?),outcome='interrupted',payload=? WHERE job_id=?").run(now,encodeTrace({...payload,resultKind:'interrupted',publication:{rowId:'silent_outcome',tableVersion:1,reaction:'silence',status:'suppressed',reason:'guard'}},traces.config().maxRecordBytes),row.job_id);}
        if (retentionMs===undefined) db.prepare('DELETE FROM response_traces WHERE job_id IN (SELECT job_id FROM response_traces WHERE expires_at<=? AND finished_at IS NOT NULL LIMIT 100)').run(now);
        const recovered = db.prepare("UPDATE queue_jobs SET state='terminal',outcome='interrupted',owner=NULL WHERE state='running'").run().changes;
        owned(db,token); return recovered;
      }).immediate());
    },
    pruneHistory(token: string) {
      if (retentionMs===undefined) return false;
      const now=Date.now();
      const tracesDeleted=transaction(token, db => db.prepare(`DELETE FROM response_traces WHERE job_id IN (
        SELECT job_id FROM response_traces WHERE expires_at<=? AND finished_at IS NOT NULL LIMIT 100)`).run(now).changes);
      return transaction(token, db => pruneHistoryMessages(db,retentionMs,now)) || tracesDeleted===100;
    },
    renew(token: string, leaseMs: number) {
      return transaction(token, db => { const expires = Date.now() + leaseMs; timestamp(expires); db.prepare('UPDATE queue_lease SET expires_at=? WHERE singleton=1').run(expires); });
    },
    release(token: string) { return connection.run(db => db.transaction(() => { owned(db, token); db.prepare('UPDATE queue_lease SET token=NULL,expires_at=0,safety_ms=0 WHERE singleton=1').run(); }).immediate()); },
    check(token: string) { connection.run(db => owned(db, token)); },
    depth(token: string) {
      return transaction(token, db => ({
        depthQueued:(db.prepare("SELECT count(*) AS n FROM queue_jobs WHERE state='queued'").get() as {n:number}).n,
        depthRunning:(db.prepare("SELECT count(*) AS n FROM queue_jobs WHERE state='running'").get() as {n:number}).n,
      }));
    },
    expire(token: string) {
      return transaction(token, db => {
        const now=Date.now();
        const rows=db.prepare("UPDATE queue_jobs SET state='terminal',outcome='expired' WHERE state='queued' AND expires_at<=? RETURNING received_at AS receivedAt").all(now) as {receivedAt:number}[];
        return rows.map(row=>Math.max(0,now-row.receivedAt));
      });
    },
    take(token: string, excluded:readonly string[]=[], platform?: string): QueueWork|null {
      return transaction(token, db => {
        const prefix = platform === undefined ? null : platform + ':';
        const row=db.prepare(`SELECT j.id,j.chat_id AS chatId,j.generation,j.message_id AS messageId,j.received_at AS receivedAt,j.route_kind AS routeKind,j.route_mode AS routeMode,j.route_group AS routeGroup,j.disclosure_version AS disclosureVersion,j.control_revision AS controlRevision
          FROM queue_jobs j JOIN chat_connections c ON c.chat_id=j.chat_id AND c.generation=j.generation
          LEFT JOIN chats s ON s.chat_id=j.chat_id LEFT JOIN queue_turns t ON t.chat_id=j.chat_id
          WHERE j.state='queued' AND j.expires_at>? AND c.state='active' AND coalesce(s.enabled,1)=1
          AND (? IS NULL OR substr(j.chat_id,1,length(?))=?)
          AND NOT EXISTS(SELECT 1 FROM queue_jobs r WHERE r.chat_id=j.chat_id AND r.state='running')
          AND j.chat_id NOT IN (SELECT value FROM json_each(?))
          ORDER BY coalesce(t.served,0),j.id LIMIT 1`).get(Date.now(),prefix,prefix,prefix,JSON.stringify(excluded)) as {routeKind:RouteMetadata['kind']|null;routeMode:RouteMetadata['mode']|null;routeGroup:number|null;disclosureVersion:number|null;controlRevision:number;id:number;chatId:ConnectionScope['chatId'];generation:number;messageId:number;receivedAt:number}|undefined;
        if(!row)return null;
        const scope=lifecycle.restore(row);
        db.prepare("UPDATE queue_jobs SET state='running',owner=? WHERE id=?").run(token,row.id);
        const work=Object.freeze({id:row.id,scope,messageId:row.messageId,receivedAt:row.receivedAt,route:row.routeKind&&row.routeMode&&row.routeGroup!==null?Object.freeze({kind:row.routeKind,mode:row.routeMode,isGroupChat:row.routeGroup===1}):null,controlRevision:row.controlRevision,
          ...(row.disclosureVersion===null?{}:{disclosureVersion:row.disclosureVersion})});
        runningRevisions.set(work,lifecycle.assertScope(db,scope).revision);
        startTrace(db,work,traces.config());return work;
      });
    },
    valid(token: string, work: QueueWork): boolean {
      return transaction(token, db => running(db, token, work));
    },
    admitModelAttempt(token: string, work: QueueWork, limits: ChatLimits|undefined, allow: () => boolean, now = Date.now, contextIds:readonly number[] = []) {
      return transaction(token, db => {
        if (!running(db, token, work) || !allow()) return false;
        const ids=sources.get(work)??[...new Set([work.messageId,...contextIds])];
        if (!historySourcesVisible(db,work.scope.chatId,ids)) return 'context_stale' as const;
        const result=limits&&work.route?admitRequestQuota(db,work,limits,now()):true;
        if (result===true) sources.set(work,ids);
        return result;
      });
    },
    autonomousQuota(token: string, limits: ChatLimits, platform?: string) {
      return createAutonomousQuotaStore(operation => transaction(token, operation), (db, scope) => {
        requireInput(platform === undefined || scope.chatId.startsWith(`${platform}:`));
        lifecycle.assertScope(db, scope);
      }, token, limits);
    },
    pruneQuotas(token: string, limits: ChatLimits, platform?: string, now = Date.now()) {
      timestamp(now);
      const prefix = platform === undefined ? null : `${platform}:`;
      return transaction(token, db => ({
        requests: pruneRequestQuota(db, limits, now, prefix),
        autonomous: pruneAutonomousQuota(db, limits, now, prefix),
      }));
    },
    publicationValid(token:string,work:QueueWork):boolean {
     return transaction(token,db=>{
      return currentWork(db,work)&&historySourcesVisible(db,work.scope.chatId,sources.get(work)??[work.messageId])&&!!db.prepare("SELECT j.id FROM queue_jobs j JOIN chats s ON s.chat_id=j.chat_id WHERE j.id=? AND j.chat_id=? AND j.generation=? AND j.state='terminal' AND s.enabled=1 AND (j.route_kind IS NULL OR s.response_mode<>'silent')").get(work.id,work.scope.chatId,work.scope.generation);
     });
    },
    progress(token:string,work:QueueWork,payload:TracePayload){
     return transaction(token,db=>{if(!this.valid(token,work))return false;let json:string;try{json=encodeTrace(payload,traces.config().maxRecordBytes);}catch(error){if(!(error instanceof StorageError)||error.code!=='limit_exceeded')throw error;traces.report('size_exceeded');json=encodeTrace(minimalTrace(payload,'size_exceeded'),traces.config().maxRecordBytes);traces.report('minimal_saved');}return db.prepare('UPDATE response_traces SET payload=? WHERE job_id=? AND finished_at IS NULL').run(json,work.id).changes===1;});
    },
    finish(token: string, work: QueueWork, outcome: QueueOutcome, payload?:TracePayload): QueueOutcome|null {
      const commit=(minimal:boolean,reason:'write_failed'|'size_exceeded'='write_failed'):QueueOutcome|null=>transaction(token, db => {
        requireInput(['completed','failed','rate_limit','interrupted','expired','message_missing','deadline_exceeded'].includes(outcome));
        const state=db.prepare('SELECT state FROM chat_connections WHERE chat_id=? AND generation=?').get(work.scope.chatId,work.scope.generation) as {state:string}|undefined;
        const final=state?.state==='active'?outcome:'interrupted';
        const result=db.prepare("UPDATE queue_jobs SET state='terminal',outcome=?,owner=NULL WHERE id=? AND owner=? AND state='running'").run(final,work.id,token);
        if(result.changes!==1)return null;
        const row=db.prepare('SELECT payload FROM response_traces WHERE job_id=?').get(work.id) as {payload:string}|undefined;
        if(!row)throw new StorageError('operation_failed');
        const base=payload??JSON.parse(row.payload) as TracePayload;
        const p:TracePayload={...base,resultKind:base.resultKind??final,publication:final==='interrupted'?{rowId:'silent_outcome',tableVersion:1,reaction:'silence',status:'suppressed',reason:'guard'}:base.publication};
        const json=encodeTrace(minimal?minimalTrace(p,reason):p,traces.config().maxRecordBytes);
        db.prepare('UPDATE response_traces SET finished_at=max(started_at,?),outcome=?,payload=? WHERE job_id=? AND finished_at IS NULL').run(Date.now(),final,json,work.id);
        if(db.prepare("SELECT id FROM queue_jobs WHERE chat_id=? AND state='queued' LIMIT 1").get(work.scope.chatId))turn(db,work.scope);
        return final;
      });
      try{return commit(false);}catch(error){
       if(error instanceof StorageError&&error.code==='queue_lost_ownership')throw error;
       traces.report(error instanceof StorageError&&error.code==='limit_exceeded'?'size_exceeded':'full_write_failed');
       try{const result=commit(true,error instanceof StorageError&&error.code==='limit_exceeded'?'size_exceeded':'write_failed');traces.report('minimal_saved');return result;}catch{traces.report('trace_write_failed');throw new StorageError('operation_failed');}
      }
    },
    get(scope: ConnectionScope, id: number): QueueRecord | null {
      requireInput(Number.isSafeInteger(id) && id > 0);
      return lifecycle.transaction(scope, db => db.prepare(`SELECT id,message_id AS messageId,received_at AS receivedAt,expires_at AS expiresAt,state,outcome
        FROM queue_jobs WHERE chat_id=? AND generation=? AND id=?`).get(scope.chatId, scope.generation, id) as QueueRecord | undefined ?? null);
    },
  };
}
export type QueueBackend = ReturnType<typeof createQueueBackend>;
