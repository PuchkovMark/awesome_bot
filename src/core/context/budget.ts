import type { LlmRequest } from '../../llm/types';
import type { AgentLoopMessage } from '../agent-loop/types';
import type { ContextConfig } from './config';
import { dataMarkerBytes } from './format';

export const contextSeparator = '\n\nОкружение харнеса:\n';

export function systemInputCost(system: string): number {
  return 128 + Buffer.byteLength(system, 'utf8');
}

export function messageInputCost(textBytes: number): number {
  return 32 + textBytes;
}

export function toolMessageInputCost(callId: string, text: string): number {
  return messageInputCost(Buffer.byteLength(JSON.stringify({ role: 'tool', callId, text })));
}

export function historyEntryInputCost(
  textBytes: number,
  group: boolean,
  hasHistory: boolean,
): number {
  // В общем массиве между элементами добавляется одна запятая. В личке каждая запись является сообщением.
  return group ? textBytes + Number(hasHistory) : messageInputCost(textBytes);
}

export function estimateInput(system: string, messages: readonly AgentLoopMessage[]): number {
  return messages.reduce(
    (cost, message) => cost + messageInputCost(Buffer.byteLength(message.text, 'utf8')),
    systemInputCost(system),
  );
}

export function staticMinimum(text: string, c: ContextConfig): number {
  return (
    estimateInput(text + contextSeparator, [{ role: 'user', text: '' }]) +
    c.environmentReserveTokens +
    256 +
    dataMarkerBytes
  );
}

export function estimateRequestInput(request: LlmRequest) {
  return (
    request.messages.reduce((cost, message) => {
      const structured =
        message.role === 'tool' || (message.role === 'assistant' && message.toolCalls);
      const text = structured ? JSON.stringify(message) : (message.text ?? '');
      return cost + messageInputCost(Buffer.byteLength(text, 'utf8'));
    }, systemInputCost(request.system)) +
    (request.tools ? Buffer.byteLength(JSON.stringify(request.tools), 'utf8') : 0)
  );
}
