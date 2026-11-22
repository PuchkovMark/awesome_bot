import { createHistoryClearStore, registerHistoryClear } from './history-retention-store.js';
import { requireInput } from './validation.js';
import {createTraceBackend,registerTraces} from './trace-store.js';
import { createNoticeBackend, registerNotices } from './notice-store.js';
import { createQueueBackend } from './queue-store.js';
import { registerQueue } from './queue-registry.js';
import {object} from './validation.js';
import {safeError} from './errors.js';
import { createVersionBackend } from './version-store.js';
import { registerVersions } from './version-registry.js';
import { versionLimits } from './version-limits.js';
import type { VersionLimits } from '../contracts/versioning.js';
import { createLifecycleBackend, registerLifecycle } from './lifecycle-store.js';
import { createDisclosureStore, registerDisclosureStore } from './chat-disclosure-store.js';
import { createAdminRecoveryStore, registerAdminRecovery } from './admin-recovery-store.js';
import { createChatControlStore, registerChatControl } from './chat-control-store.js';
import { createScopedStorage } from './scoped-storage.js';
import { openConnection } from './connection.js';
import { migrate } from './migrate.js';
import type { Storage } from './types.js';

export async function openStorage(path:string,options:{readonly versioning?:VersionLimits;readonly messageRetentionDays?:number}={}):Promise<Storage> {
 let limits:VersionLimits;
 try{object(options,['versioning','messageRetentionDays']);const snapshot={...options};limits=versionLimits(snapshot.versioning as VersionLimits|undefined);
  requireInput(snapshot.messageRetentionDays===undefined || (Number.isSafeInteger(snapshot.messageRetentionDays) && snapshot.messageRetentionDays>0 && Number.isSafeInteger(snapshot.messageRetentionDays*86_400_000)));}catch(error){throw safeError(error,'invalid_input');}
 const connection=await openConnection(path,migrate);
 try {
  const backend=createLifecycleBackend(connection);
  const versions=createVersionBackend(connection,backend,limits);
  const traces=createTraceBackend(connection,backend);
  const queue=createQueueBackend(connection,backend,traces,options.messageRetentionDays);
  const storage:Storage={...createScopedStorage(connection,backend,versions,queue),traces:{async get(scope,id){return traces.get(scope,id);},async last(scope){return traces.get(scope);}},async close(){connection.close();}};
  registerHistoryClear(storage,createHistoryClearStore(connection,backend));
  registerDisclosureStore(storage,createDisclosureStore(connection,backend));
  registerAdminRecovery(storage,createAdminRecoveryStore(connection,backend));
  registerChatControl(storage,createChatControlStore(connection,backend));
  registerTraces(storage,traces);registerNotices(storage,createNoticeBackend(connection,backend));registerQueue(storage,queue);registerLifecycle(storage,backend);registerVersions(storage,versions);return storage;
 }catch(error){connection.close();throw error;}
}
