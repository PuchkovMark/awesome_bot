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
 const limits=versionLimits(options.versioning);
 const connection=await openConnection(path,migrate);
 try {
  const backend=createLifecycleBackend(connection);
  const storage:Storage={...createScopedStorage(connection,backend),async close(){connection.close();}};
  registerLifecycle(storage,backend);registerVersions(storage,createVersionBackend(connection,backend,limits));return storage;
 }catch(error){connection.close();throw error;}
}
