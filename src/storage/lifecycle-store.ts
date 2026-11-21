import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, LifecycleObservation } from '../contracts/index.js';
import type { Connection } from './connection.js';
import { advanceClock } from './lifecycle-clock.js';
import { StorageError } from './errors.js';
import { compositeId, requireInput } from './validation.js';

interface State { chatId: ChatId; generation: number; revision: number; state: 'active' | 'uncertain' }
interface Expected { chatId: ChatId; generation: number | null; revision: number | null; clock: number }
export interface Verification { readonly expected: Expected }
export function createLifecycleBackend(connection: Connection) {
  const scopes = new WeakSet<object>(); const checks = new WeakSet<object>();
  function read(db: Database, chatId: ChatId): State | null {
    return db.prepare('SELECT chat_id AS chatId,generation,revision,state FROM chat_connections WHERE chat_id=?').get(chatId) as State | undefined ?? null;
  }
  function clock(db: Database) {return (db.prepare('SELECT value FROM lifecycle_clock WHERE singleton=1').get() as {value:number}).value;}
  function matches(db: Database, expected: Expected) {
    const state=read(db,expected.chatId);
    return expected.generation===null ? state===null && clock(db)===expected.clock : state?.generation===expected.generation && state.revision===expected.revision;
  }
  function issue(state: State): ConnectionScope {
    const scope=Object.freeze({chatId:state.chatId,generation:state.generation}) as ConnectionScope;
    scopes.add(scope); return scope;
  }
  function bump(db:Database,chatId:ChatId) {
    const result=db.prepare('UPDATE chat_connections SET revision=revision+1 WHERE chat_id=? AND revision<9007199254740991').run(chatId);
    if(result.changes!==1)throw new StorageError('operation_failed');
  }
  function create(db:Database,chatId:ChatId,state:State['state']) {
    const generation=advanceClock(db);
    db.prepare('INSERT INTO chat_connections VALUES (?,?,0,?)').run(chatId,generation,state);
  }
  function assertScope(db:Database,scope:ConnectionScope) {
    requireInput(typeof scope==='object' && scope!==null && scopes.has(scope));
    const state=read(db,scope.chatId);
    if(!state || state.generation!==scope.generation)throw new StorageError('stale_scope');
    if(state.state!=='active')throw new StorageError('uncertain_connection');
    return state;
  }
  function remove(_db:Database,_chatId:ChatId):never {
    void _db; void _chatId;
    throw new StorageError('unavailable'); // Атомарная очистка подключается отдельным шагом.
  }
  return {
    assertScope,
    transaction<T>(scope:ConnectionScope,fn:(db:Database)=>T):T {
      return connection.run(db=>db.transaction(()=>{assertScope(db,scope);return fn(db);}).immediate());
    },
    begin(chatId:ChatId):Verification {
      return connection.run(db=>{
        compositeId(chatId); const state=read(db,chatId);
        const proof=Object.freeze({expected:Object.freeze({chatId,generation:state?.generation??null,revision:state?.revision??null,clock:clock(db)})});
        checks.add(proof); return proof;
      });
    },
    current(chatId:ChatId):ConnectionScope {
      return connection.run(db=>{
        compositeId(chatId);const state=read(db,chatId);
        if(!state)throw new StorageError('stale_scope');
        if(state.state!=='active')throw new StorageError('uncertain_connection');
        return issue(state);
      });
    },
    apply(proof:Verification,observation:LifecycleObservation) {
      return connection.run(db=>db.transaction(()=>{
        requireInput(checks.has(proof)); checks.delete(proof);
        if(!matches(db,proof.expected))return {status:'stale' as const};
        const {chatId}=proof.expected;
        requireInput(['confirmed','uncertain','unavailable'].includes(observation.confidence));
        requireInput(['present','absent','unknown'].includes(observation.bot));
        for(const userId of [observation.creatorId,observation.inviterId,...(observation.members?.ids??[])]) {
          if(userId==null)continue;compositeId(userId);requireInput(userId.split(':')[0]===chatId.split(':')[0]);
        }
        if(observation.creatorChanged!==undefined)requireInput(typeof observation.creatorChanged==='boolean');
        if(observation.members)requireInput(typeof observation.members.complete==='boolean' && Array.isArray(observation.members.ids));
        let state=read(db,chatId);
        if(observation.confidence!=='confirmed' || observation.bot==='unknown') {
          if(!state)create(db,chatId,'uncertain');
          else {bump(db,chatId);db.prepare("UPDATE chat_connections SET state='uncertain' WHERE chat_id=?").run(chatId);}
          return {status:'uncertain' as const};
        }
        if(observation.bot==='absent') {if(state)remove(db,chatId);return {status:'applied' as const};}
        if(state?.state==='uncertain')return {status:'uncertain' as const};
        if(!state)create(db,chatId,'active');
        else bump(db,chatId);
        state=read(db,chatId)!;
        return {status:'applied' as const,scope:issue(state)};
      }).immediate());
    },
    ownerDecision(proof:Verification,decision:'continue'|'new'):ConnectionScope {
      return connection.run(db=>db.transaction(()=>{
        requireInput(checks.has(proof)); checks.delete(proof);
        if(!matches(db,proof.expected))throw new StorageError('stale_scope');
        const {chatId}=proof.expected; const state=read(db,chatId);
        if(decision==='new') {if(state)remove(db,chatId);create(db,chatId,'active');}
        else {
          requireInput(decision==='continue' && state!==null);
          bump(db,chatId);db.prepare("UPDATE chat_connections SET state='active' WHERE chat_id=?").run(chatId);
        }
        return issue(read(db,chatId)!);
      }).immediate());
    },
    revision(scope:ConnectionScope):number {return this.transaction(scope,db=>read(db,scope.chatId)!.revision);},
    bump,
  };
}
export type LifecycleBackend=ReturnType<typeof createLifecycleBackend>;
const backends=new WeakMap<object,LifecycleBackend>();
export function registerLifecycle(storage:object,backend:LifecycleBackend) {backends.set(storage,backend);}
export function lifecycleBackend(storage:object):LifecycleBackend {
  const backend=backends.get(storage);if(!backend)throw new StorageError('invalid_input');return backend;
}
