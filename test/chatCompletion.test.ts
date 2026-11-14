import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { AIOutputLimitError, sendChatCompletion } from '../src/services/ai/chatCompletion.js';

test('sendChatCompletion returns reasoning token usage', async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          id: 'completion-1',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'ok' },
            },
          ],
          usage: {
            total_tokens: 10,
            prompt_tokens: 2,
            completion_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 7 },
          },
        }),
      },
    },
  } as unknown as OpenAI;

  const result = await sendChatCompletion(
    client,
    'deepseek-v4.1-flash',
    'test-provider',
    [],
    'max',
    900,
  );
  assert.equal(result.reasoningTokens, 7);
});

test('sendChatCompletion reports output limit errors with the requested limit', async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          id: 'completion-1',
          choices: [
            {
              finish_reason: 'length',
              message: { role: 'assistant', content: 'partial response' },
            },
          ],
          usage: {
            total_tokens: 3,
            prompt_tokens: 1,
            completion_tokens: 2,
          },
        }),
      },
    },
  } as unknown as OpenAI;

  await assert.rejects(
    () => sendChatCompletion(client, 'model', 'test-provider', [], 'low', 900),
    (error: unknown) =>
      error instanceof AIOutputLimitError && error.limit === 900 && error.message.includes('900'),
  );
});
