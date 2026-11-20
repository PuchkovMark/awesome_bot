import type { ObjectParameterSchema, ToolContext, ToolDefinition } from '../../src/contracts/index.js';
import { FakeAdapter } from '../helpers/fake-adapters.js';

type Parameters = { readonly query: string };
export const tool: ToolDefinition<Parameters, string> = {
  name: 'example', description: 'Тестовое чтение', access: 'read',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  execute: async (parameters) => parameters.query,
};
export const context: ToolContext = { chatId: 'test-a:chat', platform: 'test-a', userId: 'test-a:known', isAdmin: 'unknown', adapter: new FakeAdapter('test-a') };
// @ts-expect-error — имя инструмента обязательно.
export const missingName: ToolDefinition<Parameters, string> = { description: 'Нет имени', parameters: tool.parameters, access: 'read', execute: tool.execute };
// @ts-expect-error — категория доступа ограничена чтением и изменением.
export const invalidAccess: ToolDefinition<Parameters, string> = { ...tool, access: 'admin' };
// @ts-expect-error — имена возможностей берутся из общего словаря.
export const invalidRequirement: ToolDefinition<Parameters, string> = { ...tool, requiredCapabilities: ['teleport'] };
// @ts-expect-error — функции не представимы JSON-данными схемы.
export const nonJson: ObjectParameterSchema = { type: 'object', custom: () => true };
// @ts-expect-error — undefined не является значением JSON.
export const undefinedJson: ObjectParameterSchema = { type: 'object', custom: undefined };
// @ts-expect-error — корневая схема должна описывать объект.
export const arrayRoot: ObjectParameterSchema = { type: 'array' };
// @ts-expect-error — результат выполнения должен соответствовать Result.
export const invalidExecute: ToolDefinition<Parameters, string> = { ...tool, execute: async () => 42 };
// @ts-expect-error — параметры функции должны соответствовать Parameters.
export const invalidParameters: ToolDefinition<Parameters, string> = { ...tool, execute: async (parameters: { value: number }) => String(parameters.value) };
const { chatId, ...withoutChat } = context;
export const chatExample = chatId;
// @ts-expect-error — область чата обязательна в контексте харнеса.
export const missingChat: ToolContext = withoutChat;
// @ts-expect-error — параметры модели проверяются по Parameters.
export const badCall = () => tool.execute({ query: 1 }, context);
