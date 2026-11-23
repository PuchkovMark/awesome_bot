import { createRouterMetrics } from './metrics';
import type { SafeLogger } from '../../logger/types';
import type { ConnectionScope, IncomingMessage, AuthorizationContext } from '../../contracts/index';
import type { Storage } from '../../storage/index';
import type { ChatQueue } from '../chat-queue/types';
import type { RoutingDecision, ServiceCommand } from './types';
import { routeMessage } from './routing';
import { validIncoming } from './validation';
import { commandAccess, type RouterAuthorization } from './command-boundary';
import type {
  FloodNotice,
  RoutedQueueDecision,
  RouteMetadata,
  RoutedAdmissionGuard,
} from '../../storage/queue-types';
function fromDecision(value: RoutedQueueDecision): RoutingDecision {
  if (value.route) return { kind: 'ordinary', reason: value.route.kind, route: value.route };
  if (value.reason === 'service') return { kind: 'service', reason: 'service' };
  return {
    kind: 'silence',
    reason: value.reason as Extract<RoutingDecision, { kind: 'silence' }>['reason'],
    ...(value.initiative ? { initiative: value.initiative } : {}),
  };
}
export interface RouterOptions {
  readonly logger?: SafeLogger;
  readonly storage: Storage;
  readonly queue: ChatQueue;
  readonly authorization?: RouterAuthorization;
  readonly recognizeCommand?: (
    message: IncomingMessage,
    replyToOther?: boolean,
  ) => ServiceCommand | null;
  readonly identity?: (
    scope: ConnectionScope,
    message: IncomingMessage,
  ) => AuthorizationContext | undefined;
  readonly executeCommand?: (
    context: AuthorizationContext,
    message: IncomingMessage,
    isCurrent: () => boolean,
    replayOnly?: boolean,
  ) => Promise<void>;
  readonly onDecision?: (decision: RoutingDecision) => void;
  readonly onFlood?: (
    scope: ConnectionScope,
    candidate: FloodNotice,
    isCurrent: () => boolean,
  ) => void;
  readonly onQueueFull?: (
    scope: ConnectionScope,
    messageId: number,
    route: RouteMetadata,
    guard: { readonly signal: AbortSignal; readonly isCurrent: () => boolean },
  ) => Promise<void>;
}
export function createMessageRouter(options: RouterOptions) {
  const metrics = createRouterMetrics(options.logger);
  return Object.freeze({
    stats: metrics.snapshot,
    async receive(
      scope: ConnectionScope,
      input: IncomingMessage,
      context?: AuthorizationContext,
      isCurrent?: () => boolean,
      disclosure?: RoutedAdmissionGuard,
      replyToOther?: boolean,
    ) {
      const message = Object.freeze({ ...input });
      if (isCurrent && !isCurrent()) return { decision: null, admission: null };
      if (!validIncoming(message) || message.chatId !== scope.chatId)
        return {
          decision: { kind: 'silence', reason: 'invalid_input' } as RoutingDecision,
          admission: null,
        };
      if (disclosure && !disclosure().journal) return { decision: null, admission: null };
      const settings = (
        await options.storage.chats.create(scope, {
          responseMode: 'normal',
          enabled: true,
          createdAt: message.timestamp,
        })
      ).settings;
      if (isCurrent && !isCurrent()) return { decision: null, admission: null };
      const command = options.recognizeCommand?.(message, replyToOther) ?? null;
      if (command) context ??= options.identity?.(scope, message);
      const service = command
        ? await commandAccess(options.authorization, context, scope, message, command)
        : undefined;
      if (isCurrent && !isCurrent()) return { decision: null, admission: null };
      if (!settings.enabled) {
        const decision = routeMessage({ message, settings, ...(service ? { service } : {}) });
        return { decision, admission: null };
      }
      const record = {
        chatId: message.chatId,
        messageId: message.messageId,
        userId: message.userId,
        authorName: message.authorName,
        isGroupChat: message.isGroupChat,
        ...(message.isGroupChat ? { senderBot: message.isBot } : {}),
        role: 'user' as const,
        attachmentCount: message.attachments.length,
        text: message.text,
        timestamp: message.timestamp,
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      };
      const result = await options.queue.admitRouted(
        scope,
        record,
        (snapshot) => {
          const decision = routeMessage({
            message,
            settings: snapshot.settings,
            considerInitiative: options.queue.autonomousReplies === true,
            ...(service ? { service } : {}),
          });
          return {
            reason: decision.reason,
            ...(decision.kind === 'service' && command?.action === 'reminder.manage'
              ? { privateCommand: true as const }
              : {}),
            route: decision.kind === 'ordinary' ? decision.route : null,
            ...(decision.kind === 'silence' && decision.initiative
              ? { initiative: decision.initiative }
              : {}),
          };
        },
        disclosure,
      );
      const decision = result.decision ? fromDecision(result.decision) : null;
      if (decision) {
        metrics?.record(decision);
        try {
          options.onDecision?.(decision);
        } catch {
          /* Диагностика не меняет решение. */
        }
      }
      if (result.floodNotice) {
        const candidate = result.floodNotice;
        options.onFlood?.(scope, candidate, () => {
          if (!options.queue.isRunning() || (isCurrent && !isCurrent())) return false;
          const gate = disclosure?.();
          return (
            !gate ||
            (gate.respond &&
              gate.ordinary !== false &&
              gate.version === candidate.disclosureVersion)
          );
        });
      }
      if (result.admission.status === 'queue_full' && decision?.kind === 'ordinary')
        await options.onQueueFull?.(scope, result.admission.messageId, decision.route, {
          signal: options.queue.signal,
          isCurrent: () => {
            if (!options.queue.isRunning() || (isCurrent && !isCurrent())) return false;
            const gate = disclosure?.();
            return !gate || (gate.respond && gate.ordinary !== false);
          },
        });
      const replayOnly = !!(
        command?.replayRequest &&
        service?.allowed &&
        (result.admission.status === 'duplicate' ||
          result.admission.status === 'history_unavailable')
      );
      if (
        context &&
        ((result.admission.status === 'not_needed' && decision?.kind === 'service') || replayOnly)
      ) {
        await options.executeCommand?.(
          context,
          message,
          () => (!isCurrent || isCurrent()) && (!disclosure || disclosure().respond),
          replayOnly || undefined,
        );
      }
      return { decision, admission: result.admission };
    },
  });
}
