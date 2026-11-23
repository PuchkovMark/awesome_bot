import type { ConnectionScope } from '../../src/contracts/index';
import type { ChatInput, ChatPatch, MessageInput, Storage } from '../../src/storage/index';
export const initial: ChatInput = { responseMode: 'normal', enabled: false, createdAt: 0 };
// @ts-expect-error — политика включения не имеет неявного default.
export const missingEnabled: ChatInput = { responseMode: 'normal', createdAt: 0 };
// @ts-expect-error — режим ответа требует явного значения.
export const missingMode: ChatInput = { enabled: true, createdAt: 0 };
// @ts-expect-error — patch не может менять дату создания.
export const badPatch: ChatPatch = { createdAt: 1 };
// @ts-expect-error — роли журнала не включают system.
export const badRole: MessageInput['role'] = 'system';
export function calls(storage: Storage, scope:ConnectionScope): void {
  void storage.chats.create(scope, initial);
  // @ts-expect-error — старый API по одному chatId запрещён.
  void storage.chats.get('vk:1');
  // @ts-expect-error — контекст чата обязателен.
  void storage.chats.get();
  // @ts-expect-error — неограниченное чтение не предусмотрено.
  void storage.messages.list(scope, {});
  // @ts-expect-error — составной id требует префикса.
  void storage.chats.get('chat');
}
