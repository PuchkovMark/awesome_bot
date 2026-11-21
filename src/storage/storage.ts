import { createLifecycleBackend, registerLifecycle } from './lifecycle-store.js';
import { createScopedStorage } from './scoped-storage.js';
import { openConnection } from './connection.js';
import { migrate } from './migrate.js';
import type { Storage } from './types.js';

export async function openStorage(path:string):Promise<Storage> {
 const connection=await openConnection(path,migrate);
 try {
  const backend=createLifecycleBackend(connection);
  const storage:Storage={...createScopedStorage(connection,backend),async close(){connection.close();}};
  registerLifecycle(storage,backend);return storage;
 }catch(error){connection.close();throw error;}
}
