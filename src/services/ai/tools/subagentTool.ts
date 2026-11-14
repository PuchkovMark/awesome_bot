import config from '../../../config/index.js';
import { logger } from '../../../logger/index.js';
import {
  MAX_PARTICIPANTS,
  type ParticipantResolution,
  type ResolvedParticipant,
} from '../../memory/memoryService.js';
import type { AITool } from '../AIProvider.js';
import type { HistoryEstimate } from '../chatDigestService.js';
import { isRecord, parseIsoDateTime } from './dateTime.js';

export type SubagentFormat = 'summary' | 'timeline' | 'list' | 'answer';

export type SubagentRequest = {
  task: string;
  count?: number;
  from?: Date;
  to?: Date;
  format: SubagentFormat;
  maxOutputChars: number;
  parts: number;
  participants: ResolvedParticipant[];
};

export type SubagentStartResult =
  | { status: 'accepted'; jobId: string }
  | { status: 'already_running'; jobId: string }
  | { status: 'not_executed'; message: string };

type SubagentToolContext = {
  isChat: boolean;
  checkAccess: () => Promise<{ allowed: true } | { allowed: false; message: string }>;
  resolveParticipants: (references: string[]) => Promise<ParticipantResolution>;
  estimateMessages: (input: {
    count?: number;
    from?: Date;
    to?: Date;
    participantUserIds?: string[];
    includeBot?: boolean;
  }) => Promise<HistoryEstimate>;
  startJob: (request: SubagentRequest) => Promise<SubagentStartResult>;
  acknowledge: (text: string) => Promise<void>;
  onStarted: () => void;
};

const MAX_OUTPUT_CHARS = Math.min(3_500, config.SUBAGENT_MAX_OUTPUT_CHARS);
const MIN_TASK_CHARS = 10;
const MAX_TASK_CHARS = 2_000;

function invalid(message: string): string {
  return JSON.stringify({ status: 'not_executed', message });
}

/**
 * Запускает фонового субагента для большой задачи по SQL-истории.
 */
export function createSubagentTool(context: SubagentToolContext): AITool {
  return {
    name: 'run_subagent',
    description: [
      'Запусти фонового субагента для большой задачи по сохранённой SQL-истории текущей беседы или личного диалога.',
      'Используй для пересказа большого периода, хронологии, поиска закономерностей, извлечения решений и анализа сотен или тысяч сообщений.',
      `Для периода указывай from/to; для последних сообщений — count. В анализ попадает не более ${config.SUBAGENT_MAX_MESSAGES} сообщений. Если период больше, инструмент откажет — попроси пользователя сузить диапазон, не запускай несколько задач автоматически.`,
      'Субагент читает только SQL, не обращается к VK, не отправляет сообщения и не выполняет действия.',
      `Можно ограничить выборку участниками: participants — от 1 до ${MAX_PARTICIPANTS} имён, полных имён или VK ID. Пенёк и имя текущего персонажа означают сообщения бота.`,
      'В task опиши точную задачу и формат результата: субагент не сможет задать уточняющий вопрос. Не делегируй короткие фрагменты — для них есть get_local_chat_history.',
      `Задача выполняется в фоне; результат придёт отдельным сообщением позже. До ${config.SUBAGENT_MAX_PARTS} частей.`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          minLength: MIN_TASK_CHARS,
          maxLength: MAX_TASK_CHARS,
          description: 'Что именно должен сделать субагент и какой результат вернуть.',
        },
        count: {
          type: 'integer',
          minimum: 1,
          description: 'Количество последних сообщений; альтернатива from/to.',
        },
        from: { type: 'string', description: 'Начало периода в ISO 8601 с часовым поясом.' },
        to: { type: 'string', description: 'Конец периода в ISO 8601 с часовым поясом.' },
        format: {
          type: 'string',
          enum: ['summary', 'timeline', 'list', 'answer'],
          description: 'Формат итогового ответа.',
        },
        max_output_chars: {
          type: 'integer',
          minimum: 500,
          maximum: MAX_OUTPUT_CHARS,
        },
        parts: {
          type: 'integer',
          minimum: 1,
          maximum: config.SUBAGENT_MAX_PARTS,
          description: 'Сколько частей обрабатывать параллельно: 1 или 2.',
        },
        participants: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PARTICIPANTS,
          items: { type: 'string', minLength: 1, maxLength: 120 },
          description:
            'Имена, полные имена или VK ID авторов. Пенёк или имя персонажа означают сообщения бота.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    async execute(input) {
      if (
        !isRecord(input) ||
        Object.keys(input).some(
          (key) =>
            key !== 'task' &&
            key !== 'count' &&
            key !== 'from' &&
            key !== 'to' &&
            key !== 'format' &&
            key !== 'max_output_chars' &&
            key !== 'parts' &&
            key !== 'participants',
        )
      ) {
        return invalid('Некорректные аргументы задачи субагента.');
      }
      if (
        typeof input.task !== 'string' ||
        input.task.trim().length < MIN_TASK_CHARS ||
        input.task.length > MAX_TASK_CHARS
      ) {
        return invalid(
          `task должен быть строкой от ${MIN_TASK_CHARS} до ${MAX_TASK_CHARS} символов.`,
        );
      }

      const hasCount = input.count !== undefined;
      const hasFrom = input.from !== undefined;
      const hasTo = input.to !== undefined;
      if (hasCount && (hasFrom || hasTo)) {
        return invalid('Используй либо count, либо from и to, но не одновременно.');
      }
      if (!hasCount && (!hasFrom || !hasTo)) {
        return invalid('Укажи count или полный период from/to.');
      }
      let count: number | undefined;
      if (hasCount) {
        if (
          typeof input.count !== 'number' ||
          !Number.isSafeInteger(input.count) ||
          input.count < 1
        ) {
          return invalid('count должен быть положительным целым числом.');
        }
        count = input.count;
      }
      let from: Date | undefined;
      let to: Date | undefined;
      if (hasFrom || hasTo) {
        if (typeof input.from !== 'string' || typeof input.to !== 'string') {
          return invalid('from и to должны быть строками ISO 8601.');
        }
        from = parseIsoDateTime(input.from);
        to = parseIsoDateTime(input.to);
        if (!from || !to || from >= to) {
          return invalid('Укажи корректный период: from раньше to, обе даты в ISO 8601.');
        }
        if (to.getTime() > Date.now()) {
          return invalid('Период не должен заканчиваться в будущем.');
        }
      }

      const format = input.format ?? 'summary';
      if (
        format !== 'summary' &&
        format !== 'timeline' &&
        format !== 'list' &&
        format !== 'answer'
      ) {
        return invalid('format должен быть summary, timeline, list или answer.');
      }
      const maxOutputChars = input.max_output_chars ?? MAX_OUTPUT_CHARS;
      if (
        typeof maxOutputChars !== 'number' ||
        !Number.isSafeInteger(maxOutputChars) ||
        maxOutputChars < 500 ||
        maxOutputChars > MAX_OUTPUT_CHARS
      ) {
        return invalid(`max_output_chars должен быть от 500 до ${MAX_OUTPUT_CHARS}.`);
      }
      const parts = input.parts ?? 1;
      if (
        typeof parts !== 'number' ||
        !Number.isSafeInteger(parts) ||
        parts < 1 ||
        parts > config.SUBAGENT_MAX_PARTS
      ) {
        return invalid(`parts должен быть от 1 до ${config.SUBAGENT_MAX_PARTS}.`);
      }

      let participantReferences: string[] = [];
      if (input.participants !== undefined) {
        if (!context.isChat) {
          return invalid('Фильтр по участникам доступен только в групповой беседе.');
        }
        if (
          !Array.isArray(input.participants) ||
          input.participants.length < 1 ||
          input.participants.length > MAX_PARTICIPANTS ||
          input.participants.some(
            (item) => typeof item !== 'string' || item.trim().length === 0 || item.length > 120,
          )
        ) {
          return invalid(
            `participants должен содержать от 1 до ${MAX_PARTICIPANTS} имён или VK ID.`,
          );
        }
        participantReferences = [
          ...new Set(input.participants.map((item) => (item as string).trim()).filter(Boolean)),
        ];
      }

      let resolvedParticipants: ResolvedParticipant[] = [];
      if (participantReferences.length > 0) {
        const resolution = await context.resolveParticipants(participantReferences);
        if (resolution.ambiguous.length > 0) {
          return JSON.stringify({
            status: 'needs_clarification',
            message: 'Уточните участников задачи.',
            ambiguous: resolution.ambiguous,
            not_found: resolution.notFound,
          });
        }
        if (resolution.notFound.length > 0) {
          return JSON.stringify({
            status: 'not_found',
            message: `В этой беседе не найдены авторы: ${resolution.notFound.join(', ')}.`,
            not_found: resolution.notFound,
          });
        }
        resolvedParticipants = resolution.participants;
      }
      const participantUserIds = resolvedParticipants.flatMap((participant) =>
        participant.kind === 'user' ? [participant.dbUserId] : [],
      );
      const includeBot = resolvedParticipants.some((participant) => participant.kind === 'bot');

      const access = await context.checkAccess();
      if (!access.allowed) {
        return JSON.stringify({ status: 'not_executed', message: access.message });
      }

      let estimate: HistoryEstimate;
      try {
        estimate = await context.estimateMessages({
          ...(count ? { count } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(participantUserIds.length > 0 ? { participantUserIds } : {}),
          ...(includeBot ? { includeBot } : {}),
        });
      } catch (error) {
        logger.warn(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Unable to estimate subagent history',
        );
        return JSON.stringify({
          status: 'error',
          message: 'Не удалось проверить локальную историю. Попробуйте позже.',
        });
      }

      const availableCount = estimate.count;
      const period = from && to ? { from: from.toISOString(), to: to.toISOString() } : undefined;
      if (availableCount < config.SUBAGENT_MIN_MESSAGES) {
        return JSON.stringify({
          status: 'not_executed',
          ...(period ? { period } : {}),
          requested_count: count ?? null,
          available_count: availableCount,
          message:
            'В локальной истории слишком мало сообщений для субагента. Используй get_local_chat_history и ответь напрямую.',
        });
      }
      if (availableCount > config.SUBAGENT_MAX_MESSAGES) {
        return JSON.stringify({
          status: 'not_executed',
          reason: 'too_many_messages',
          ...(period ? { period } : {}),
          requested_count: count ?? null,
          available_count: availableCount,
          max_messages: config.SUBAGENT_MAX_MESSAGES,
          message: period
            ? `В выбранном периоде ${period.from} — ${period.to} ${availableCount} сообщений. Максимум для одного пересказа — ${config.SUBAGENT_MAX_MESSAGES}. Сузьте диапазон.`
            : `В локальной истории доступно ${availableCount} сообщений. Максимум для одного пересказа — ${config.SUBAGENT_MAX_MESSAGES}. Запросите последние ${config.SUBAGENT_MAX_MESSAGES} сообщений.`,
        });
      }

      const estimatedChunks = Math.max(
        1,
        Math.ceil(availableCount / config.SUMMARY_CHUNK_MESSAGES),
        Math.ceil(estimate.chars / config.SUMMARY_CHUNK_CHARS),
      );
      const estimatedInputTokens = Math.ceil(estimate.chars / 4) + estimatedChunks * 300;
      if (estimate.chars > config.SUBAGENT_MAX_SUMMARY_CHARS) {
        return JSON.stringify({
          status: 'not_executed',
          reason: 'too_many_chars',
          ...(period ? { period } : {}),
          requested_count: count ?? null,
          available_count: availableCount,
          available_chars: estimate.chars,
          max_chars: config.SUBAGENT_MAX_SUMMARY_CHARS,
          message: period
            ? `В выбранном периоде ${period.from} — ${period.to} ${estimate.chars} символов истории. Максимум — ${config.SUBAGENT_MAX_SUMMARY_CHARS}. Сузьте диапазон.`
            : `В локальной истории ${estimate.chars} символов. Максимум — ${config.SUBAGENT_MAX_SUMMARY_CHARS}. Запросите меньший фрагмент.`,
        });
      }
      if (estimatedChunks > config.SUBAGENT_MAX_SUMMARY_CHUNKS) {
        return JSON.stringify({
          status: 'not_executed',
          reason: 'too_many_chunks',
          ...(period ? { period } : {}),
          requested_count: count ?? null,
          available_count: availableCount,
          available_chars: estimate.chars,
          estimated_chunks: estimatedChunks,
          max_chunks: config.SUBAGENT_MAX_SUMMARY_CHUNKS,
          message: period
            ? `Выбранный период требует примерно ${estimatedChunks} чанков; максимум — ${config.SUBAGENT_MAX_SUMMARY_CHUNKS}. Сузьте диапазон.`
            : `Выборка требует примерно ${estimatedChunks} чанков; максимум — ${config.SUBAGENT_MAX_SUMMARY_CHUNKS}. Запросите меньший фрагмент.`,
        });
      }
      if (estimatedInputTokens > config.SUBAGENT_MAX_ESTIMATED_INPUT_TOKENS) {
        return JSON.stringify({
          status: 'not_executed',
          reason: 'too_many_tokens',
          ...(period ? { period } : {}),
          requested_count: count ?? null,
          available_count: availableCount,
          available_chars: estimate.chars,
          estimated_chunks: estimatedChunks,
          estimated_input_tokens: estimatedInputTokens,
          max_estimated_input_tokens: config.SUBAGENT_MAX_ESTIMATED_INPUT_TOKENS,
          message: period
            ? `Выбранный период требует примерно ${estimatedInputTokens} input-токенов; максимум — ${config.SUBAGENT_MAX_ESTIMATED_INPUT_TOKENS}. Сузьте диапазон.`
            : `Выборка требует примерно ${estimatedInputTokens} input-токенов; максимум — ${config.SUBAGENT_MAX_ESTIMATED_INPUT_TOKENS}. Запросите меньший фрагмент.`,
        });
      }

      const request: SubagentRequest = {
        task: input.task.trim(),
        ...(count !== undefined ? { count } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        format,
        maxOutputChars,
        parts,
        participants: resolvedParticipants,
      };

      let started: SubagentStartResult;
      try {
        started = await context.startJob(request);
      } catch (error) {
        logger.error(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Unable to start subagent job',
        );
        return JSON.stringify({
          status: 'error',
          message: 'Не удалось запустить фоновую задачу. Попробуйте позже.',
        });
      }

      if (started.status === 'not_executed') {
        return JSON.stringify({
          status: 'not_executed',
          ...(period ? { period } : {}),
          message: started.message,
          requested_count: count ?? null,
          available_count: availableCount,
          available_chars: estimate.chars,
          estimated_chunks: estimatedChunks,
        });
      }
      if (started.status === 'already_running') {
        return JSON.stringify({
          status: 'already_running',
          job_id: started.jobId,
          message:
            'В этой беседе уже выполняется фоновая задача. Дождитесь результата или уточните статус через get_subagent_status.',
        });
      }

      const coverage =
        count && availableCount < count
          ? ` В локальной истории доступно ${availableCount} сообщений; обработаю их.`
          : '';
      const participantText =
        resolvedParticipants.length > 0
          ? ` Участники: ${resolvedParticipants.map((participant) => participant.name).join(', ')}.`
          : '';
      const text = `Принял задачу. Обрабатываю ${availableCount} сообщений в фоне${parts > 1 ? ' двумя частями' : ''}.${participantText} Пришлю результат ответом на это сообщение.${coverage}`;
      try {
        await context.acknowledge(text);
      } catch (error) {
        logger.warn(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Unable to acknowledge subagent start',
        );
      } finally {
        context.onStarted();
      }

      return JSON.stringify({
        status: 'accepted',
        job_id: started.jobId,
        ...(period ? { period } : {}),
        requested_count: count ?? null,
        available_count: availableCount,
        available_chars: estimate.chars,
        estimated_chunks: estimatedChunks,
        estimated_input_tokens: estimatedInputTokens,
        parts,
        ...(resolvedParticipants.length > 0
          ? { participants: resolvedParticipants.map((participant) => participant.name) }
          : {}),
        message: text,
      });
    },
  };
}
