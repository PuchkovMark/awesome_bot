/// <reference lib="esnext.temporal" />
import type { ChannelAdapter } from '../contracts/index';
import { contextSeparator } from '../core/context/budget';
import type { LlmClient } from '../llm/types';

export const historyEvaluationAdapter: ChannelAdapter = {
  platform: 'synthetic',
  async capabilities(context) {
    return {
      context,
      observedAt: 0,
      maxMessageLength: 'unknown',
      textFormats: ['plain'],
      support: {
        send: 'supported',
        reply: 'supported',
        typing: 'unknown',
        getUserName: 'unknown',
        adminInfo: 'unknown',
        membershipEvents: 'unknown',
        directMessage: 'unknown',
      },
    };
  },
  async start() {},
  async send() {
    throw Error('Сетевой вызов на оценочном стенде.');
  },
  async sendTyping() {},
  async getUserName() {
    return null;
  },
};

export const yesterdayClient: LlmClient = {
  async complete(request) {
    const result = request.messages.find((m) => m.role === 'tool');
    const usage = { input: null, output: null };
    if (result) {
      const { messages } = JSON.parse(result.text) as { messages: { text: string }[] };
      return { kind: 'complete', text: messages.map((m) => m.text).join(' '), usage };
    }
    const { utc, timezone } = JSON.parse(request.system.split(contextSeparator).at(-1)!);
    const today = Temporal.Instant.from(utc).toZonedDateTimeISO(timezone).startOfDay();
    const from = today.subtract({ days: 1 }).startOfDay().toInstant().toString();
    return {
      kind: 'tool_calls',
      text: null,
      calls: [
        {
          name: 'history_period',
          id: 'yesterday',
          arguments: JSON.stringify({ from, to: today.toInstant().toString() }),
        },
      ],
      usage,
    };
  },
};
