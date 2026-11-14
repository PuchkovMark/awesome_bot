import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { AIOutputLimitError, sendChatCompletion } from '../src/services/ai/chatCompletion.js';

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
