import type {Storage} from './types.js';
import type {CatalogAdministration} from './version-types.js';
import {versionBackend} from './version-registry.js';
/** Только доверенная композиция приложения; не аутентифицирует человека. */
export function catalogAdministration(storage:Storage):CatalogAdministration {
 const backend=versionBackend(storage);
 return Object.freeze({
  async append(input){return backend.appendGlobal(input);},
  async get(ref){return backend.getGlobal(ref);},
  async systemPrompt(){return backend.globalSelected();},
  async selectSystemPrompt(ref,expected){return backend.selectGlobal(ref,expected);},
  async resetSystemPrompt(expected){return backend.selectGlobal(null,expected);},
 } satisfies CatalogAdministration);
}
