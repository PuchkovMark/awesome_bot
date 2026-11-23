import {
  compressTexts,
  summarizeMessages,
  summaryPromptVersion,
  type Compression,
} from '../core/chat-summaries/compress';
import type { LlmClient } from '../llm/types';
import { estimateRequestInput } from '../core/context/budget';

import { chatSummaryCase } from './scenarios';
export async function evaluateChatSummary(client: LlmClient, signal: AbortSignal) {
  let calls = 0,
    maxInput = 0;
  const host: Compression = {
    signal,
    sessionId: 'a'.repeat(64),
    inputLimit: 4000,
    outputLimit: 512,
    async invoke(request) {
      if (calls >= 6 || estimateRequestInput(request) > 4000 || request.maxOutputTokens > 512)
        throw Error('Превышение бюджета оценки');
      calls++;
      maxInput = Math.max(maxInput, estimateRequestInput(request));
      return client.complete(request);
    },
  };
  const fragments: string[] = [];
  for (const [author, text] of chatSummaryCase.facts) {
    fragments.push(
      await compressTexts(
        summarizeMessages([{ author, text, timestamp: Date.UTC(2026, 10, 23, 12) }], 'UTC'),
        host,
      ),
    );
  }
  const text = await compressTexts(fragments, host);
  const passed = summaryFactChecks(text).every((check) => check.matches);
  return { passed, text, calls, maxInput, prompt: summaryPromptVersion };
}

export function summaryFactChecks(text: string) {
  const clean = text
    .replace(/[*_]/gu, '')
    .replace(/\d{2}\.\d{2}\.\d{4}/gu, '')
    .toLocaleLowerCase('ru')
    .replace(/ё/gu, 'е');
  return [
    { id: 'meeting-room', matches: /зал(?:е|а)?\s+[«"]?б/u.test(clean) },
    {
      id: 'key-promise-author',
      matches:
        /(?:ира|ирина)(?!\p{L})[^.!?\n]{0,110}?(?:принес|прин[её]сти|возьм|возмет)[^.!?\n]{0,36}ключ/u.test(
          clean,
        ),
    },
    {
      id: 'corrected-date',
      matches:
        /28(?:\s+ноября|[./-]11)/u.test(clean) &&
        !/(?:с\s+28(?:\s+ноября)?\s+на\s+27|(?:перенес\p{L}* на|теперь|итоговая дата)\s+27(?:\s+ноября|[./-]11))/u.test(
          clean,
        ),
    },
  ];
}
