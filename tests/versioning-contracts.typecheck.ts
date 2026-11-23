import type { LocalVersionRef, VersionInput, LocalContentKind } from '../src/contracts/versioning';
const local: LocalVersionRef = {
  area: 'local',
  // @ts-expect-error системного промпта нет в локальной области
  kind: 'system_prompt',
  key: 'x',
  version: 1,
  chatId: 'vk:1',
  generation: 1,
};
const input: VersionInput<LocalContentKind> = {
  // @ts-expect-error локальный ввод ограничен двумя видами
  kind: 'system_prompt',
  key: 'x',
  text: '',
  createdAt: 0,
  expectedHead: null,
};
void local;
void input;
