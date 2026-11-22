import type {AuthorizationContext,ConnectionScope} from '../../contracts/index.js';
import type {Storage} from '../../storage/index.js';
import type {createAuthorizationService} from '../authorization/service.js';
import {traceBackend} from '../../storage/trace-store.js';
/** Только доверенная композиция: проверка личности и чтение выполняются в одной транзакции. */
export function createTraceDiagnostics(options:{readonly storage:Storage;readonly authorization:Pick<Awaited<ReturnType<typeof createAuthorizationService>>,'readDiagnostics'>}){
 const backend=traceBackend(options.storage);
 return Object.freeze({
  get(context:AuthorizationContext,jobId:number){return options.authorization.readDiagnostics(context,()=>backend.get(context.scope,jobId));},
  last(context:AuthorizationContext){return options.authorization.readDiagnostics(context,()=>backend.get(context.scope));},
 });
}
/** Порт инфраструктурной очистки, не команда участника и не инструмент модели. */
export function createTraceMaintenance(storage:Storage){
 const backend=traceBackend(storage);
 return Object.freeze({prune(scope:ConnectionScope,now:number,limit=100){return backend.prune(scope,now,limit);}});
}
