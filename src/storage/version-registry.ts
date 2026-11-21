import type {VersionBackend} from './version-store.js';
import {StorageError} from './errors.js';
const backends=new WeakMap<object,VersionBackend>();
export function registerVersions(storage:object,backend:VersionBackend):void {backends.set(storage,backend);}
/** Внутренняя связь, не запросный API и не выдача административного объекта. */
export function versionBackend(storage:object):VersionBackend {const backend=backends.get(storage);if(!backend)throw new StorageError('invalid_input');return backend;}
