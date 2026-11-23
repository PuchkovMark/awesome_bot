import { openStorage as openRealStorage } from '../../src/storage/index';
import type { Storage } from '../../src/storage/index';
import type { ChatId, ConnectionScope } from '../../src/contracts/index';
import { lifecycleBackend } from '../../src/storage/lifecycle-store';
import { createAuthorizationService as createRealAuthorizationService } from '../../src/core/index';
import type { AuthorizationOptions } from '../../src/core/index';
const stores=new WeakMap<object,Storage>(),services=new WeakMap<object,Storage>();
/** Явный синтетический источник только fixtures. Не используется приложением. */
export function scopeFor(storage:Storage,chatId:unknown):ConnectionScope {
 const backend=lifecycleBackend(storage);
 if(typeof chatId!=='string'|| !/^[a-z][a-z0-9_-]*:[^\s]+$/.test(chatId))return {chatId} as ConnectionScope;
 const id=chatId as ChatId;
 try{return backend.current(id);}catch(error) {
  const code=(error as {code?:string}).code;
  if(code==='closed')return {chatId} as ConnectionScope;
  if(code==='uncertain_connection')return backend.ownerDecision(backend.begin(id),'continue');
  if(code!=='stale_scope')throw error;
  return backend.apply(backend.begin(id),{confidence:'confirmed',bot:'present'}).scope!;
 }
}
export async function openStorage(path:string):Promise<Storage> {
 const storage=await openRealStorage(path);stores.set(storage.authorization.transaction,storage);return storage;
}
export async function createAuthorizationService(options:AuthorizationOptions) {
 const service=await createRealAuthorizationService(options);
 const storage=stores.get(options.store.transaction);if(storage)services.set(service,storage);
 return service;
}
export function scopeForService(service:object,chatId:ChatId) {
 const storage=services.get(service);if(!storage)throw new Error('Missing test scope fixture');return scopeFor(storage,chatId);
}
