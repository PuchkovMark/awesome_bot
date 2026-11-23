import type { AgentLoopInput, AgentLoopResult } from '../src/core/index';
const input: AgentLoopInput = { system: '', messages: [{ role: 'user', text: 'Привет' }], sessionId: 'opaque', maxOutputTokens: 1 };
// @ts-expect-error инструментального режима в первой версии нет
const tools: AgentLoopInput = { ...input, tools: [] };
// @ts-expect-error история tool не допускается
const history: AgentLoopInput = { ...input, messages: [{ role: 'tool', text: 'x', callId: 'x' }] };
// @ts-expect-error неполный результат не является complete
const incomplete: AgentLoopResult = { kind: 'complete', partialText: 'x' };
void tools; void history; void incomplete;
