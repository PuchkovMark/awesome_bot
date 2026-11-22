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
import { createScopedStorage } from './scoped-storage.js';
import { openConnection } from './connection.js';
import { migrate } from './migrate.js';
import type { Storage } from './types.js';

export async function openStorage(path:string,options:{readonly versioning?:VersionLimits}={}):Promise<Storage> {
 let limits:VersionLimits;
 try{object(options,['versioning']);const snapshot={...options};limits=versionLimits(snapshot.versioning as VersionLimits|undefined);}catch(error){throw safeError(error,'invalid_input');}
 const connection=await openConnection(path,migrate);
 try {
  const backend=createLifecycleBackend(connection);
  const versions=createVersionBackend(connection,backend,limits);
  const traces=createTraceBackend(connection,backend);
  const queue=createQueueBackend(connection,backend);
  const storage:Storage={...createScopedStorage(connection,backend,versions,queue),traces:{async get(scope,id){return traces.get(scope,id);},async last(scope){return traces.get(scope);}},async close(){connection.close();}};
  registerTraces(storage,traces);registerNotices(storage,createNoticeBackend(connection,backend));registerQueue(storage,queue);registerLifecycle(storage,backend);registerVersions(storage,versions);return storage;
 }catch(error){connection.close();throw error;}
}
