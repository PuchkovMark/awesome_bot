import type {
  CapabilitySnapshot, CapabilityState, ChannelAdapter, EventHandler,
  MessageLengthLimit, SendResult,
} from '../../src/contracts/index.js';
import { FakeAdapter } from '../helpers/fake-adapters.js';

export const adapter: ChannelAdapter = new FakeAdapter('test-a');
export const result: SendResult = ['one', 'two'];
export const limit: MessageLengthLimit = { value: 1, unit: 'unicodeCodePoints' };
export const unknownLimit: MessageLengthLimit = 'unknown';
// @ts-expect-error — список успешной отправки не бывает пустым.
export const emptyResult: SendResult = [];
// @ts-expect-error — неизвестное состояние задано явно, произвольные строки запрещены.
export const badState: CapabilityState = 'maybe';
// @ts-expect-error — числовой предел требует единицы измерения.
export const bareLimit: MessageLengthLimit = 100;
// @ts-expect-error — метод start обязателен.
export const missingMethod: ChannelAdapter = { platform: 'test-a', capabilities: adapter.capabilities, send: adapter.send, sendTyping: adapter.sendTyping, getUserName: adapter.getUserName };
// @ts-expect-error — обработчик асинхронный и принимает объединение событий.
export const badHandler: EventHandler = (event: string) => event;
// @ts-expect-error — id результата строковые.
export const badSend: ChannelAdapter['send'] = async () => [42];
// @ts-expect-error — время наблюдения снимка обязательно.
export const incompleteSnapshot: CapabilitySnapshot = { context: { chatId: 'test-a:chat' }, support: {}, maxMessageLength: 'unknown', textFormats: [] };
