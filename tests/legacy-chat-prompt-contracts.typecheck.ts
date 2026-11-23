import type { ChatInput, ChatPatch, ChatSettings } from '../src/storage/index';
import type {
  ChatInput as InternalInput,
  ChatPatch as InternalPatch,
  ChatSettings as InternalSettings,
} from '../src/storage/legacy-types';
export function removedChatField(settings: ChatSettings, internal: InternalSettings) {
  const input: ChatInput = {
    responseMode: 'normal',
    enabled: true,
    createdAt: 0,
    // @ts-expect-error Индивидуальный промпт удалён из входа создания.
    systemPrompt: 'x',
  };
  // @ts-expect-error Даже null не является допустимым patch.
  const patch: ChatPatch = { systemPrompt: null };
  // @ts-expect-error Чтение больше не выдаёт поле.
  void settings.systemPrompt;
  const oldInput: InternalInput = {
    responseMode: 'normal',
    enabled: true,
    createdAt: 0,
    // @ts-expect-error Внутренний SQL-контракт тоже не содержит поля.
    systemPrompt: 'x',
  };
  // @ts-expect-error Нельзя сохранить старую форму во внутренних типах.
  const oldPatch: InternalPatch = { systemPrompt: null };
  // @ts-expect-error Поле отсутствует и во внутреннем чтении.
  void internal.systemPrompt;
  void input;
  void patch;
  void oldInput;
  void oldPatch;
}
