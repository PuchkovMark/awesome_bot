import type { LlmMessage, LlmRequest, LlmResult, LlmToolDescription } from '../src/llm/index.js';
const tool: LlmToolDescription = { name: 'lookup', description: 'Поиск', parameters: { type: 'object' } };
const message: LlmMessage = { role: 'tool', callId: 'one', text: 'Ответ' };
const request: LlmRequest = { system: '', messages: [message], tools: [tool], maxOutputTokens: 1, sessionId: 'opaque' };
// @ts-expect-error execute не является частью транспортного описания
const executable: LlmToolDescription = { ...tool, execute: () => 'not sent' };
// @ts-expect-error аргументы — строка, клиент не разбирает их
const result: LlmResult = { kind: 'tool_calls', calls: [{ id: 'a', name: 'x', arguments: {} }], text: null, usage: { input: null, output: 0 } };
void request; void executable; void result;
