import config from '../../../config/index.js';
import { logger } from '../../../logger/index.js';
import type { AITool } from '../AIProvider.js';

type DigestRequest = {
  count?: number;
  from?: Date;
  to?: Date;
  maxDigestChars: number;
};

type StartResult =
  | { status: 'accepted'; jobId: string }
  | { status: 'already_running'; jobId: string; requestedCount?: number | null };

type ChatDigestToolContext = {
  checkAccess: () => Promise<{ allowed: true } | { allowed: false; message: string }>;
  startJob: (request: DigestRequest) => Promise<StartResult>;
  acknowledge: (text: string) => Promise<void>;
  onStarted: () => void;
};

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

function parseDateTime(value: string): Date | undefined {
  if (!ISO_DATE_TIME.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Запускает фоновую подготовку истории: Haiku делает выжимки, Аргон — финальный пересказ.
 */
export function createChatDigestTool(context: ChatDigestToolContext): AITool {
  return {
    name: 'get_chat_digest',
    description: [
      'Запусти фоновую обработку большого фрагмента истории текущей беседы или личного диалога.',
      'Haiku подготовит структурированные выжимки, а основная модель Аргон затем составит финальный пересказ.',
      'Используй count для последних N сообщений или from/to для периода. Жёсткого максимума сообщений нет; обрабатывается столько, сколько доступно.',
      'Инструмент сразу сообщает пользователю, что запрос принят, и возвращает результат позже ответом на исходное сообщение.',
      'Для короткого фрагмента до 20 сообщений используй get_local_chat_history, а не этот инструмент. Не пытайся получить большой объём через get_vk_chat_history.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          minimum: 1,
          description: 'Количество последних сообщений; без жёсткого верхнего предела.',
        },
        from: {
          type: 'string',
          description: 'Начало периода в ISO 8601 с часовым поясом.',
        },
        to: {
          type: 'string',
          description: 'Конец периода в ISO 8601 с часовым поясом.',
        },
        max_digest_chars: {
          type: 'integer',
          minimum: 2_000,
          maximum: 30_000,
          description: 'Максимальный размер структурированных выжимок для Аргона.',
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      if (
        !isRecord(input) ||
        Object.keys(input).some(
          (key) => key !== 'count' && key !== 'from' && key !== 'to' && key !== 'max_digest_chars',
        )
      ) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'Укажите count или from/to, при необходимости max_digest_chars.',
        });
      }

      const hasCount = input.count !== undefined;
      const hasFrom = input.from !== undefined;
      const hasTo = input.to !== undefined;
      if (hasCount && (hasFrom || hasTo)) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'Используйте либо count, либо from и to, но не одновременно.',
        });
      }
      if (!hasCount && (!hasFrom || !hasTo)) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'Укажите count или полный период from/to.',
        });
      }
      if (
        hasCount &&
        (typeof input.count !== 'number' || !Number.isSafeInteger(input.count) || input.count < 1)
      ) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'count должен быть положительным целым числом.',
        });
      }
      if (hasCount && typeof input.count === 'number' && input.count <= 20) {
        return JSON.stringify({
          status: 'not_executed',
          message:
            'Для короткого фрагмента до 20 сообщений используйте get_local_chat_history; get_chat_digest предназначен для больших объёмов.',
        });
      }
      if (
        input.max_digest_chars !== undefined &&
        (typeof input.max_digest_chars !== 'number' ||
          !Number.isSafeInteger(input.max_digest_chars) ||
          input.max_digest_chars < 2_000 ||
          input.max_digest_chars > 30_000)
      ) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'max_digest_chars должен быть от 2000 до 30000.',
        });
      }

      let from: Date | undefined;
      let to: Date | undefined;
      if (hasFrom || hasTo) {
        if (typeof input.from !== 'string' || typeof input.to !== 'string') {
          return JSON.stringify({
            status: 'not_executed',
            message: 'from и to должны быть строками ISO 8601.',
          });
        }
        from = parseDateTime(input.from);
        to = parseDateTime(input.to);
        if (!from || !to || from >= to) {
          return JSON.stringify({
            status: 'not_executed',
            message: 'Укажите корректный период: from раньше to, обе даты в ISO 8601.',
          });
        }
      }

      const access = await context.checkAccess();
      if (!access.allowed) {
        return JSON.stringify({ status: 'not_executed', message: access.message });
      }

      const request: DigestRequest = {
        ...(typeof input.count === 'number' ? { count: input.count } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        maxDigestChars:
          typeof input.max_digest_chars === 'number'
            ? input.max_digest_chars
            : config.SUMMARY_MAX_DIGEST_CHARS,
      };

      let started: StartResult;
      try {
        started = await context.startJob(request);
      } catch (error) {
        logger.error(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Unable to start chat digest job',
        );
        return JSON.stringify({
          status: 'error',
          message: 'Не удалось запустить обработку истории. Попробуйте позже.',
        });
      }
      const text =
        started.status === 'already_running'
          ? 'Этот запрос уже выполняется. Пришлю пересказ, как только он будет готов.'
          : 'Принял запрос. Обрабатываю историю в фоне и пришлю пересказ ответом на это сообщение.';
      try {
        await context.acknowledge(text);
        context.onStarted();
      } catch (error) {
        logger.warn(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Unable to send digest acknowledgement',
        );
      }
      return JSON.stringify({
        status: started.status,
        job_id: started.jobId,
        message: text,
      });
    },
  };
}
