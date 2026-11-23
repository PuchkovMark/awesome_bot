import type { CardCandidate, ContextCardReader, PreparedCards } from './participant-cards';
import type { AddressForm, UserId } from '../../contracts/index';
import { addressPrompt } from './address-prompt';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import type { ConnectionScope } from '../../contracts/lifecycle';
import type { CapabilitySnapshot } from '../../contracts/capabilities';
import type {
  ContextMessage,
  ContextMessageReader,
  ContextStateReader,
} from '../../storage/context-types';
import { contextConfig, type ContextConfig } from './config';
import {
  contextSeparator,
  estimateInput,
  historyEntryInputCost,
  messageInputCost,
  systemInputCost,
} from './budget';
import { validateContextStartup } from './startup';
import { formatEnvironment, type ContextRoute } from './environment';
import { createContextMessageFormatter } from './format';
import type { AgentLoopMessage } from '../agent-loop/types';
import type { ContextMetadata, PreparationResult } from './types';
import { createContextMetrics } from './metrics';
const unavailableReplyJson = JSON.stringify({ unavailable: true });

export interface ContextWork {
  readonly scope: ConnectionScope;
  readonly messageId: number;
  readonly route: ContextRoute | null;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly initiativeEvidenceId?: number;
}
export interface ContextBuilderOptions {
  readonly messages: ContextMessageReader;
  readonly state: ContextStateReader;
  readonly config: Pick<ContextConfig, 'modelContextTokens'> & Partial<ContextConfig>;
  readonly capabilities: (scope: ConnectionScope) => Promise<CapabilitySnapshot>;
  readonly onStats?: (
    stats: ReturnType<ReturnType<typeof createContextMetrics>['snapshot']>,
  ) => void;
  readonly sessionId: (scope: ConnectionScope) => string;
  readonly now?: () => number;
  readonly participantCards?: ContextCardReader;
  readonly addressForm?: (
    scope: ConnectionScope,
    userId: UserId,
    sourceTime: number,
    isGroupChat: boolean,
  ) => AddressForm | undefined;
}

export function createContextBuilder(options: ContextBuilderOptions) {
  const config = contextConfig(options.config);
  const metrics = createContextMetrics();

  function effectivePrompt(version: Parameters<typeof validateContextStartup>[0]) {
    return version && options.addressForm
      ? { ...version, text: version.text + '\n\n' + addressPrompt }
      : version;
  }

  const reportStats = () => {
    try {
      options.onStats?.(metrics.snapshot());
    } catch {
      // Сбой диагностики не должен прерывать подготовку.
    }
  };

  async function build(work: ContextWork, signal: AbortSignal): Promise<PreparationResult> {
    const isWorkCurrent = () => !signal.aborted && work.isCurrent();
    if (!isWorkCurrent()) return { kind: 'cancelled' };

    const { scope, route } = work;
    if (!route) return { kind: 'unavailable' };

    const currentMessage = await options.messages.get(scope, work.messageId);
    if (!isWorkCurrent()) return { kind: 'cancelled' };
    if (!currentMessage || currentMessage.role !== 'user') return { kind: 'unavailable' };
    const currentJournalId = currentMessage.id;
    const currentUser = currentMessage.userId;
    const { isGroupChat } = route;

    const settings = await options.state.settings(scope);
    if (!isWorkCurrent()) return { kind: 'cancelled' };
    if (!settings?.enabled || settings.responseMode === 'silent') return { kind: 'cancelled' };

    const systemPrompt = effectivePrompt(await options.state.systemPrompt(scope));
    if (!isWorkCurrent()) return { kind: 'cancelled' };
    const startupFailure = validateContextStartup(systemPrompt, config);
    if (startupFailure) return { kind: 'failed', reason: startupFailure };
    if (
      !systemPrompt ||
      systemPrompt.ref.area !== 'global' ||
      systemPrompt.ref.kind !== 'system_prompt'
    ) {
      return { kind: 'failed', reason: 'internal_error' };
    }

    const capabilities = await options.capabilities(scope);
    if (!isWorkCurrent()) return { kind: 'cancelled' };
    if (
      capabilities.context.chatId !== scope.chatId ||
      (capabilities.context.userId !== undefined &&
        capabilities.context.userId !== currentMessage.userId)
    ) {
      return { kind: 'failed', reason: 'internal_error' };
    }

    const environment = formatEnvironment({
      now: options.now?.() ?? Date.now(),
      timezone: settings.timezone,
      platform: scope.chatId.split(':')[0]!,
      capabilities,
      route,
    });
    const environmentBytes = Buffer.byteLength(environment, 'utf8');
    if (environmentBytes > config.environmentReserveTokens) {
      return { kind: 'failed', reason: 'internal_error' };
    }
    const system = systemPrompt.text + contextSeparator + environment;

    const address = options.addressForm?.(
      scope,
      currentMessage.userId,
      currentMessage.timestamp,
      route.isGroupChat,
    );
    if (!isWorkCurrent()) return { kind: 'cancelled' };
    const formatter = createContextMessageFormatter(
      currentMessage,
      route.isGroupChat,
      settings.timezone,
      options.addressForm ? (address?.text ?? currentMessage.authorName) : undefined,
    );
    const authorLabels = new Set<string>();
    let initiatingAuthor: CardCandidate | undefined;
    const candidates = new Map<UserId, CardCandidate>();
    const cardReader = options.participantCards;
    function includeAuthor(message: ContextMessage, evidenceOnly = false) {
      const label = formatter.authorLabel(message);
      if (label) authorLabels.add(label);
      if (
        !cardReader ||
        evidenceOnly ||
        message.role !== 'user' ||
        message.senderBot !== false ||
        (isGroupChat ? label === undefined : scope.chatId !== message.userId)
      )
        return;
      const row: CardCandidate = {
        userId: message.userId,
        author: message.authorName,
        ...(label === undefined ? {} : { authorLabel: label }),
        timestamp: message.timestamp,
        id: message.id,
      };
      if (message.id === currentJournalId) {
        const shownAddress = options.addressForm
          ? (address?.text ?? message.authorName)
          : undefined;
        initiatingAuthor = { ...row, ...(shownAddress === undefined ? {} : { shownAddress }) };
      } else if (message.userId !== currentUser) {
        const existing = candidates.get(message.userId);
        if (
          !existing ||
          row.timestamp > existing.timestamp ||
          (row.timestamp === existing.timestamp && row.id > existing.id)
        )
          candidates.set(row.userId, row);
      }
    }
    includeAuthor(currentMessage);
    let evidenceField = '';
    const evidenceId = work.initiativeEvidenceId;
    if (route.kind === 'initiative' && route.cause === 'unanswered') {
      if (evidenceId === undefined || evidenceId >= currentJournalId)
        return { kind: 'unavailable' };
      const evidence = await options.messages.get(scope, evidenceId);
      if (!isWorkCurrent()) return { kind: 'cancelled' };
      if (!evidence) return { kind: 'unavailable' };
      includeAuthor(evidence, true);
      evidenceField = ',"initiativeEvidence":' + formatter.serializeEntry({ message: evidence });
    }
    // Неиспользованный резерв окружения не увеличивает окно истории.
    const fixedInputCost =
      systemInputCost(system) +
      messageInputCost(formatter.fixedLatestTextBytes) +
      Buffer.byteLength(evidenceField) +
      config.environmentReserveTokens -
      environmentBytes;
    const inputCostWithReply = (replyJson: string) =>
      fixedInputCost + Buffer.byteLength(replyJson, 'utf8');

    const replyPlatformMessageId = currentMessage.replyToMessageId;
    let replyState: ContextMetadata['reply'] = replyPlatformMessageId ? 'unavailable' : 'none';
    let replyJson = replyPlatformMessageId ? unavailableReplyJson : 'null';
    if (inputCostWithReply(replyJson) > config.inputBudgetTokens) {
      return { kind: 'failed', reason: 'current_message_too_large' };
    }

    let replyJournalId: number | undefined;
    if (replyPlatformMessageId) {
      const quotedMessage = await options.messages.reply(
        scope,
        replyPlatformMessageId,
        currentJournalId,
        config.replyTextCodePoints,
      );
      if (!isWorkCurrent()) return { kind: 'cancelled' };

      if (quotedMessage && quotedMessage.id !== currentJournalId) {
        replyJournalId = quotedMessage.id;
        replyJson = formatter.serializeEntry({
          message: quotedMessage,
          truncated: quotedMessage.truncated,
        });
        replyState = quotedMessage.truncated ? 'truncated' : 'included';

        if (inputCostWithReply(replyJson) > config.inputBudgetTokens) {
          // Каждый кандидат пересчитывает только стоимость выдержки.
          const codePoints = Array.from(quotedMessage.text);
          let minCodePoints = 0;
          let maxCodePoints = codePoints.length;
          let fittingReply: string | undefined;

          while (minCodePoints < maxCodePoints) {
            const candidateCodePoints = Math.ceil((minCodePoints + maxCodePoints) / 2);
            const candidate = formatter.serializeEntry({
              message: {
                ...quotedMessage,
                text: codePoints.slice(0, candidateCodePoints).join(''),
              },
              truncated: true,
            });
            if (inputCostWithReply(candidate) <= config.inputBudgetTokens) {
              minCodePoints = candidateCodePoints;
              fittingReply = candidate;
            } else {
              maxCodePoints = candidateCodePoints - 1;
            }
          }

          replyJson = fittingReply ?? unavailableReplyJson;
          replyState = fittingReply === undefined ? 'unavailable' : 'truncated';
        }
        if (replyState !== 'unavailable') includeAuthor(quotedMessage);
      }
    }

    const includedReplyId =
      replyState === 'included' || replyState === 'truncated' ? replyJournalId : undefined;
    const replyCount = Number(includedReplyId !== undefined) + Number(evidenceField !== '');
    const history: { readonly journalId: number; readonly serialized: AgentLoopMessage }[] = [];
    let inputCost = inputCostWithReply(replyJson);

    let beforeJournalId = currentJournalId;
    let scannedMessages = 0;
    let historyTruncated = replyCount === config.maxHistoryMessages;
    let stopReadingHistory = false;
    while (
      !stopReadingHistory &&
      scannedMessages < config.maxScannedMessages &&
      history.length + replyCount < config.maxHistoryMessages
    ) {
      const pageLimit = Math.min(
        config.historyPageSize,
        config.maxScannedMessages - scannedMessages,
      );
      const page = await options.messages.page(scope, {
        cutoffId: currentJournalId,
        beforeId: beforeJournalId,
        limit: pageLimit,
        textLimit: config.historyTextCodePoints,
      });
      if (!isWorkCurrent()) return { kind: 'cancelled' };
      if (!page.length) break;

      for (const message of page) {
        scannedMessages++;
        beforeJournalId = message.id;
        if (message.id === replyJournalId || message.id === evidenceId) continue;

        const serialized = formatter.serializeHistoryEntry({
          message,
          truncated: message.truncated,
        });
        const candidateCost =
          inputCost +
          historyEntryInputCost(
            Buffer.byteLength(serialized.text, 'utf8'),
            route.isGroupChat,
            history.length > 0,
          );
        if (candidateCost > config.inputBudgetTokens) {
          historyTruncated = true;
          stopReadingHistory = true;
          break;
        }
        history.push({ journalId: message.id, serialized });
        includeAuthor(message);
        inputCost = candidateCost;
        if (message.truncated) historyTruncated = true;
        if (history.length + replyCount >= config.maxHistoryMessages) {
          historyTruncated = true;
          stopReadingHistory = true;
          break;
        }
      }
      if (page.length < pageLimit) break;

      await yieldImmediate();
      if (!isWorkCurrent()) return { kind: 'cancelled' };
    }
    if (scannedMessages >= config.maxScannedMessages) historyTruncated = true;

    const latestSettings = await options.state.settings(scope);
    if (!isWorkCurrent()) return { kind: 'cancelled' };
    if (!latestSettings?.enabled || latestSettings.responseMode === 'silent') {
      return { kind: 'cancelled' };
    }

    history.reverse();
    const messages = Object.freeze(
      formatter
        .messages(
          history.map((entry) => entry.serialized),
          replyJson,
          evidenceField,
        )
        .map((message) => Object.freeze(message)),
    );
    const estimatedTokens = estimateInput(system, messages);
    if (estimatedTokens > config.inputBudgetTokens) {
      return { kind: 'failed', reason: 'internal_error' };
    }
    const participantCards: PreparedCards | undefined =
      cardReader && (initiatingAuthor || candidates.size)
        ? {
            candidates: Object.freeze([
              ...(initiatingAuthor ? [initiatingAuthor] : []),
              ...[...candidates.values()].sort((a, b) => b.timestamp - a.timestamp || b.id - a.id),
            ]),
            messageIndex: messages.length - 1,
            modelContextTokens: config.modelContextTokens,
            read: (actor) =>
              cardReader.read(scope, actor, currentMessage.timestamp, route.isGroupChat),
            current: (refs) => cardReader.current(scope, refs),
          }
        : undefined;
    const metadata = Object.freeze({
      version: Object.freeze({ ...systemPrompt.ref }),
      cutoffId: currentJournalId,
      messageIds: Object.freeze([
        ...history.map((entry) => entry.journalId),
        ...(includedReplyId === undefined ? [] : [includedReplyId]),
        ...(evidenceField ? [evidenceId!] : []),
        currentJournalId,
      ]),
      layerBytes: Object.freeze({
        system: Buffer.byteLength(systemPrompt.text),
        environment: environmentBytes,
        messages: messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.text), 0),
      }),
      estimatedTokens,
      scanned: scannedMessages,
      historyTruncated,
      reply: replyState,
      absentLayers: Object.freeze(['persona', 'passport', 'profiles', 'memory', 'summaries']),
    });
    return {
      kind: 'ready',
      input: Object.freeze({
        system,
        messages,
        maxOutputTokens: config.maxOutputTokens,
        sessionId: options.sessionId(scope),
      }),
      metadata,
      ...(participantCards ? { participantCards } : {}),
      ...(address ? { addressPreference: address.reference } : {}),
      ...(authorLabels.size ? { authorLabels: Object.freeze([...authorLabels]) } : {}),
    };
  }

  return Object.freeze({
    config,
    stats: metrics.snapshot,
    checkStartup(version: Parameters<typeof validateContextStartup>[0]) {
      const failure = validateContextStartup(effectivePrompt(version), config);
      if (failure) metrics.record(failure);
      reportStats();
      return failure;
    },
    async prepare(work: ContextWork): Promise<PreparationResult> {
      const deadline = new AbortController();
      const signal = AbortSignal.any([work.signal, deadline.signal]);
      let onAbort: () => void = () => {};
      const interrupted = new Promise<PreparationResult>((resolve) => {
        onAbort = () => resolve({ kind: work.signal.aborted ? 'cancelled' : 'deadline_exceeded' });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const timeout = setTimeout(() => deadline.abort(), config.preparationTimeoutMs);
      try {
        const result = await Promise.race([
          build(work, signal).catch((): PreparationResult =>
            signal.aborted
              ? { kind: work.signal.aborted ? 'cancelled' : 'deadline_exceeded' }
              : { kind: 'failed', reason: 'internal_error' },
          ),
          interrupted,
        ]);
        metrics.record(result);
        reportStats();
        return result;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      }
    },
  });
}
