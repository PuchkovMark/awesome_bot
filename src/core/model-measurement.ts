import type { ModelAttemptMeter, ModelStep } from '../contracts/chat-metrics';
import type { LlmResult } from '../llm/types';

/** Вызывается внутри допуска F9.1 непосредственно у клиента. */
export async function measureModelCall(
  meter: ModelAttemptMeter | undefined,
  invoke: () => Promise<LlmResult>,
  step?: ModelStep,
): Promise<LlmResult> {
  try {
    meter?.sent?.(step);
  } catch (error) {
    meter?.cancelBeforeSend();
    throw error;
  }
  let result: LlmResult;
  try {
    result = await invoke();
  } catch (error) {
    meter?.failed?.();
    throw error;
  }
  if (result?.kind === 'error' && result.code !== 'cancelled') meter?.failed?.();
  return result;
}
