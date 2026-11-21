import type { LlmClient } from '../../llm/types.js';
import type { AgentLoopInput, AgentLoopOptions } from '../agent-loop/types.js';
import { createAgentLoop } from '../agent-loop/service.js';
import { loopOptions } from '../agent-loop/validation.js';
import { createChatQueue } from './service.js';
import type { ChatQueueOptions, QueueHandlerInput, QueueConfig } from './types.js';
export interface AgentLoopQueueOptions extends Omit<ChatQueueOptions,'handler'|'config'> {
  readonly client: LlmClient;
  readonly loopOptions?: AgentLoopOptions;
  readonly config?: Omit<Partial<QueueConfig>,'loopTimeoutMs'>;
  readonly prepare: (work: QueueHandlerInput) => Promise<Omit<AgentLoopInput,'signal'>>;
}
/** Один снимок реальных настроек цикла и срока очереди, без HTTP-реализации клиента. */
export function createAgentLoopQueue(options: AgentLoopQueueOptions) {
  const settings=loopOptions(options.loopOptions ?? {});
  const loop=createAgentLoop(options.client,settings);
  const prepare=options.prepare;
  return createChatQueue({storage:options.storage,...(options.logger?{logger:options.logger}:{}),
    ...(options.onSettled?{onSettled:options.onSettled}:{}),
    config:{...options.config,loopTimeoutMs:settings.timeoutMs},
    handler:async work=>{
      const input=await prepare(work);
      const result=await loop.run({...input,signal:work.signal});
      const outcome=result.kind==='complete'?'completed':result.kind==='rate_limit'?'rate_limit':result.kind==='deadline_exceeded'?'deadline_exceeded':result.kind==='cancelled'?'interrupted':'failed';
      return {outcome,result};
    }});
}
