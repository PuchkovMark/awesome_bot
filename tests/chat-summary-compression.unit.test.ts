import { expect, test } from 'vitest';
import { compressTexts, summarizeMessages } from '../src/core/chat-summaries/compress';
import { estimateRequestInput } from '../src/core/context/budget';
test('шум пропускается, длинные экранированные реплики и все объединения ограничены', async () => {
  const inputs = summarizeMessages(
    ['', ' + ', 'Ок', '👍', 'В пятницу', 'я"'.repeat(4000)].map((text) => ({
      text,
      author: 'Ира',
      timestamp: 100,
    })),
    'UTC',
  );
  expect(inputs).toHaveLength(2);
  let calls = 0;
  const result = await compressTexts(inputs, {
    inputLimit: 2200,
    outputLimit: 256,
    sessionId: 'test',
    signal: new AbortController().signal,
    async invoke(request) {
      expect(estimateRequestInput(request)).toBeLessThanOrEqual(2200);
      calls++;
      return { kind: 'complete', text: 'В пятницу', usage: { input: 1, output: 1 } };
    },
  });
  expect(result).toBe('В пятницу');
  expect(calls).toBeGreaterThan(2);
});
