/// <reference lib="esnext.temporal" />
import type { ChannelAdapter } from '../contracts/index';
import { contextSeparator } from '../core/context/budget';
import type { LlmClient, LlmRequest } from '../llm/types';
import { isRecord } from '../llm/validation';
import type { HistorySearchOutcome } from './types';

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

const unknownUsage = { input: null, output: null };

function yesterday(request: LlmRequest) {
  const { utc, timezone } = JSON.parse(request.system.split(contextSeparator).at(-1)!);
  const today = Temporal.Instant.from(utc).toZonedDateTimeISO(timezone).startOfDay();
  return {
    from: today.subtract({ days: 1 }).startOfDay().toInstant().toString(),
    to: today.toInstant().toString(),
  };
}

export const yesterdayClient: LlmClient = {
  async complete(request) {
    const result = request.messages.find((m) => m.role === 'tool');
    if (result) {
      const { messages } = JSON.parse(result.text) as { messages: { text: string }[] };
      return {
        kind: 'complete',
        text: messages.map((m) => m.text).join(' '),
        usage: unknownUsage,
      };
    }
    return {
      kind: 'tool_calls',
      text: null,
      calls: [
        {
          name: 'history_period',
          id: 'yesterday',
          arguments: JSON.stringify(yesterday(request)),
        },
      ],
      usage: unknownUsage,
    };
  },
};

export function historySearchExchange(request: LlmRequest | null) {
  if (!request) return;
  const calls = request.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const [call] = calls;
  if (calls.length !== 1 || call?.name !== 'history_search') return;
  const response = request.messages.find(
    (message) => message.role === 'tool' && message.callId === call.id,
  );
  if (response?.role !== 'tool') return;
  try {
    const args: unknown = JSON.parse(call.arguments);
    const result: unknown = JSON.parse(response.text);
    if (isRecord(args) && isRecord(result)) return { args, result };
  } catch {
    return;
  }
}

export const historySearchClient: LlmClient = {
  async complete(request) {
    if (request.messages.some(({ role }) => role === 'tool')) {
      const result = historySearchExchange(request)?.result;
      if (result?.error === 'tool_failed')
        return {
          kind: 'complete',
          text: 'Сейчас не удалось проверить переписку.',
          usage: unknownUsage,
        };
      const first: unknown = Array.isArray(result?.messages) ? result.messages[0] : undefined;
      const text =
        isRecord(first) && typeof first.text === 'string'
          ? first.text
          : result?.found === 0
            ? 'В доступной переписке за вчера не нашёл упоминаний встречи.'
            : 'По результату поиска место встречи подтвердить не удалось.';
      return { kind: 'complete', text, usage: unknownUsage };
    }
    return {
      kind: 'tool_calls',
      text: null,
      calls: [
        {
          name: 'history_search',
          id: 'meeting-search',
          arguments: JSON.stringify({ query: 'встреча', ...yesterday(request) }),
        },
      ],
      usage: unknownUsage,
    };
  },
};

const fountainPlace = /(?:у|около|возле)\s+фонтана|рядом\s+с\s+фонтаном/iu;
const unfoundedDoubt =
  /возможно|вероятно|предполож|не\s+(?:уверен|знаю|удалось|смог|подтвержд|определил|выбрали|решил|договорил)|неизвестн|нет\s+данных/iu;
const availableHistory =
  /доступн[а-яё]+\s+(?:мне\s+)?(?:части\s+)?(?:переписк|истори|журнал|сообщен)/iu;
const noMatches =
  /не\s+(?:наш[её]л|нашл[а-яё]+|найден|обнаруж|вижу|видно|упомина)|(?:нет|отсутству[а-яё]+)\s+(?:совпаден|упоминан|сообщен)|(?:совпадений|упоминаний|сообщений)(?:\s+(?:о|про|по)\s+[^.!?]{0,32})?\s+нет|не\s+(?:дал[ао]?|вернул[ао]?)\s+(?:результат|совпаден)/iu;
const categoricalAbsence =
  /встреч[а-яё]*\s+(?:вчера\s+)?не\s+обсужда|не\s+обсужда[а-яё]*\s+(?:эту\s+)?встреч|обсуждени[а-яё]*\s+(?:встреч[а-яё]*\s+)?не\s+было/iu;
const assertedPlace =
  /фонтан|(?:встреча|встретимся)\s+(?:у|в|на|возле|около)\s+(?!(?:доступн|переписк|истори|журнал|запис|сообщен))[а-яё]|(?:встреча|место\s+встречи)\s*(?:[—–:-]\s*|(?:будет|пройд[её]т|состоится|назначена)\s+)(?:у|в|на|возле|около)\s+[а-яё]/iu;
const cannotReadHistory =
  /не\s+(?:удалось|получилось|смог(?:ла)?|могу)\s+(?:сейчас\s+)?(?:проверить|прочитать|просмотреть|открыть|выполнить\s+поиск)|нет\s+доступа\s+к\s+(?:истори|переписк|журнал)/iu;
const reportsHistoryError =
  /(?:истори|переписк|журнал|поиск)[^.!?]{0,48}(?:недоступ|заверш[а-яё]+\s+(?:ошиб|со\s+сбо))|(?:сбой|ошибка)\s+(?:при|в)\s+(?:чтени|проверк|поиск)/iu;

export function answersHistorySearch(outcome: HistorySearchOutcome, text: string) {
  if (outcome === 'found')
    return (
      fountainPlace.test(text) &&
      !/не\s+(?:у|около|возле|рядом)/iu.test(text) &&
      !/\?\s*$/u.test(text) &&
      !unfoundedDoubt.test(text) &&
      !categoricalAbsence.test(text)
    );
  if (categoricalAbsence.test(text) || assertedPlace.test(text)) return false;
  const unavailable = cannotReadHistory.test(text) || reportsHistoryError.test(text);
  if (outcome === 'failed') return unavailable && !noMatches.test(text);
  return availableHistory.test(text) && noMatches.test(text) && !unavailable;
}
