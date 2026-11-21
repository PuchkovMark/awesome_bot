import type {LocalVersionRef,VersionInput,LocalContentKind} from '../src/contracts/versioning.js';
// @ts-expect-error системного промпта нет в локальной области
const local:LocalVersionRef={area:'local',kind:'system_prompt',key:'x',version:1,chatId:'vk:1',generation:1};
// @ts-expect-error локальный ввод ограничен двумя видами
const input:VersionInput<LocalContentKind>={kind:'system_prompt',key:'x',text:'',createdAt:0,expectedHead:null};
void local;void input;
