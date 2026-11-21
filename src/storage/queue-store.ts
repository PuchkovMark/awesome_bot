import { createChatStore } from './chats.js';
import type { RoutedQueueCallback, RoutedAdmission, RouteMetadata } from './queue-types.js';
import { createMessageStore, readMessage } from './messages.js';
import type { MessageInput } from './types.js';
import type { QueueConfig, QueueDecision, QueueAdmission } from './queue-types.js';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index.js';
import type { Connection } from './connection.js';
import type { LifecycleBackend } from './lifecycle-store.js';
import type { QueueWork, QueueOutcome, QueueRecord } from './queue-types.js';
import { StorageError } from './errors.js';
import { requireInput, timestamp } from './validation.js';
export function createQueueBackend(connection: Connection, lifecycle: LifecycleBackend) {
  function owned(db: Database, token: string) {
    const row = db.prepare('SELECT token,expires_at AS expires FROM queue_lease WHERE singleton=1').get() as {token:string|null;expires:number};
    if (row.token !== token || row.expires <= Date.now()) throw new StorageError('queue_lost_ownership');
  }
  function transaction<T>(token: string, operation: (db: Database) => T): T {
    return connection.run(db => db.transaction(() => { owned(db, token); const result = operation(db); owned(db, token); return result; }).immediate());
  }
  function turn(db:Database, scope:{readonly chatId:string;readonly generation:number}) {
    const row=db.prepare('UPDATE queue_lease SET sequence=sequence+1 WHERE singleton=1 AND sequence<9007199254740991 RETURNING sequence').get() as {sequence:number}|undefined;
    if(!row)throw new StorageError('operation_failed');
    db.prepare('INSERT INTO queue_turns(chat_id,generation,served) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET served=excluded.served').run(scope.chatId,scope.generation,row.sequence);
  }
  const messages = createMessageStore(connection);
  return {
    transaction,
    admitRouted(token:string,scope:ConnectionScope,message:MessageInput,decision:RoutedQueueCallback,config:QueueConfig):RoutedAdmission {
     return transaction(token,()=>lifecycle.transaction(scope,db=>{
      let chosen:import('./queue-types.js').RoutedQueueDecision|null=null;
      const admission=this.admit(token,scope,message,snapshot=>{
       const settings=createChatStore(connection).get(scope.chatId);requireInput(settings);
       const value:unknown=decision(Object.freeze({...snapshot,settings:Object.freeze(settings)}));
       if(value instanceof Promise){void value.catch(()=>{});throw new StorageError('invalid_input');}
       requireInput(value!==null&&typeof value==='object');
       const result=value as import('./queue-types.js').RoutedQueueDecision;
       requireInput(['direct_message','mention','reply','name','service','disabled','silent','sender_bot','sender_unknown','invalid_input','not_addressed','forbidden'].includes(result.reason));
       if(result.route!==null){requireInput(['direct_message','mention','reply','name'].includes(result.route.kind)&&['normal','active'].includes(result.route.mode)&&typeof result.route.isGroupChat==='boolean'&&result.reason===result.route.kind);}
       chosen=Object.freeze({reason:result.reason,route:result.route===null?null:Object.freeze({...result.route})});return chosen.route!==null;
      },config);
      const route=(chosen as import('./queue-types.js').RoutedQueueDecision|null)?.route;
      if(admission.status==='queued'&&route)db.prepare('UPDATE queue_jobs SET route_kind=?,route_mode=?,route_group=? WHERE id=?').run(route.kind,route.mode,route.isGroupChat?1:0,admission.jobId);
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
    acquire(token: string, leaseMs: number, safetyMs: number) {
      requireInput(typeof token === 'string' && token.length > 0); timestamp(leaseMs); timestamp(safetyMs);
      return connection.run(db => db.transaction(() => {
        const now = Date.now(); timestamp(now + leaseMs);
        const row = db.prepare('SELECT token,expires_at AS expires FROM queue_lease WHERE singleton=1').get() as {token:string|null;expires:number};
        if (row.token !== null && row.expires > now) throw new StorageError('queue_owned');
        db.prepare('UPDATE queue_lease SET token=?,expires_at=?,safety_ms=? WHERE singleton=1').run(token, now + leaseMs, safetyMs);
        const recovered = db.prepare("UPDATE queue_jobs SET state='terminal',outcome='interrupted',owner=NULL WHERE state='running'").run().changes;
        owned(db,token); return recovered;
      }).immediate());
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
    take(token: string, excluded:readonly string[]=[]): QueueWork|null {
      return transaction(token, db => {
        const row=db.prepare(`SELECT j.id,j.chat_id AS chatId,j.generation,j.message_id AS messageId,j.received_at AS receivedAt,j.route_kind AS routeKind,j.route_mode AS routeMode,j.route_group AS routeGroup
          FROM queue_jobs j JOIN chat_connections c ON c.chat_id=j.chat_id AND c.generation=j.generation
          LEFT JOIN chats s ON s.chat_id=j.chat_id LEFT JOIN queue_turns t ON t.chat_id=j.chat_id
          WHERE j.state='queued' AND j.expires_at>? AND c.state='active' AND coalesce(s.enabled,1)=1
          AND NOT EXISTS(SELECT 1 FROM queue_jobs r WHERE r.chat_id=j.chat_id AND r.state='running')
          AND j.chat_id NOT IN (SELECT value FROM json_each(?))
          ORDER BY coalesce(t.served,0),j.id LIMIT 1`).get(Date.now(),JSON.stringify(excluded)) as {routeKind:RouteMetadata['kind']|null;routeMode:RouteMetadata['mode']|null;routeGroup:number|null;id:number;chatId:ConnectionScope['chatId'];generation:number;messageId:number;receivedAt:number}|undefined;
        if(!row)return null;
        const scope=lifecycle.restore(row);
        db.prepare("UPDATE queue_jobs SET state='running',owner=? WHERE id=?").run(token,row.id);
        return Object.freeze({id:row.id,scope,messageId:row.messageId,receivedAt:row.receivedAt,route:row.routeKind&&row.routeMode&&row.routeGroup!==null?Object.freeze({kind:row.routeKind,mode:row.routeMode,isGroupChat:row.routeGroup===1}):null});
      });
    },
    valid(token: string, work: QueueWork): boolean {
      return transaction(token, db => {
        const row=db.prepare("SELECT j.id FROM queue_jobs j JOIN chat_connections c ON c.chat_id=j.chat_id AND c.generation=j.generation LEFT JOIN chats s ON s.chat_id=j.chat_id WHERE j.id=? AND j.owner=? AND j.state='running' AND c.state='active' AND coalesce(s.enabled,1)=1").get(work.id,token);
        return !!row;
      });
    },
    publicationValid(token:string,work:QueueWork):boolean {
     return transaction(token,db=>!!db.prepare("SELECT j.id FROM queue_jobs j JOIN chat_connections c ON c.chat_id=j.chat_id AND c.generation=j.generation JOIN chats s ON s.chat_id=j.chat_id WHERE j.id=? AND j.chat_id=? AND j.generation=? AND j.state='terminal' AND c.state='active' AND s.enabled=1").get(work.id,work.scope.chatId,work.scope.generation));
    },
    finish(token: string, work: QueueWork, outcome: QueueOutcome): QueueOutcome|null {
      return transaction(token, db => {
        requireInput(['completed','failed','rate_limit','interrupted','expired','message_missing','deadline_exceeded'].includes(outcome));
        const state=db.prepare('SELECT state FROM chat_connections WHERE chat_id=? AND generation=?').get(work.scope.chatId,work.scope.generation) as {state:string}|undefined;
        const final=state?.state==='active'?outcome:'interrupted';
        const result=db.prepare("UPDATE queue_jobs SET state='terminal',outcome=?,owner=NULL WHERE id=? AND owner=? AND state='running'").run(final,work.id,token);
        if(result.changes===1 && db.prepare("SELECT id FROM queue_jobs WHERE chat_id=? AND state='queued' LIMIT 1").get(work.scope.chatId))turn(db,work.scope);
        return result.changes===1?final:null;
      });
    },
    get(scope: ConnectionScope, id: number): QueueRecord | null {
      requireInput(Number.isSafeInteger(id) && id > 0);
      return lifecycle.transaction(scope, db => db.prepare(`SELECT id,message_id AS messageId,received_at AS receivedAt,expires_at AS expiresAt,state,outcome
        FROM queue_jobs WHERE chat_id=? AND generation=? AND id=?`).get(scope.chatId, scope.generation, id) as QueueRecord | undefined ?? null);
    },
  };
}
export type QueueBackend = ReturnType<typeof createQueueBackend>;
