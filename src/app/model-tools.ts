import type { ChannelAdapter, UserId, ToolContext } from '../contracts/index';
import type { LlmClient, LlmRequest, LlmToolDescription, LlmUsage } from '../llm/types';
import type { LoopTools } from '../core/agent-loop/types';
import { estimateRequestInput, toolMessageInputCost } from '../core/context/budget';
import { delegateDescription } from '../core/agent-loop/delegation';
import {
  createJobDelegation,
  delegateFeedback,
  fitsToolEnvelope,
} from '../core/chat-queue/delegated-attempts';
import type {
  AgentLoopQueueOptions,
  QueuePreparation,
} from '../core/chat-queue/agent-loop-adapter';
import type { createAuthorizationService } from '../core/authorization/service';
import { createToolRegistry, type RuntimeTool, type ToolExecution } from '../tools/registry';
import { historyTools } from '../tools/history';
import { participantTools } from '../tools/participants';
import { participantRegistryStore } from '../storage/participant-registry';
import { addressPreferenceStore } from '../storage/address-preference-store';
import type { Storage } from '../storage/types';

function exposedMaterial(ready: Extract<QueuePreparation, { kind: 'ready' }>) {
  const material = new Map<string, { ref: string; text: string; messageIds: number[] }>();
  const ids = ready.metadata?.messageIds ?? [];
  let index = 0,
    history = 0;
  function add(ref: string, value: unknown) {
    const id = ids[index++];
    if (id !== undefined) material.set(ref, { ref, text: JSON.stringify(value), messageIds: [id] });
  }
  for (const msg of ready.input.messages) {
    const fields = JSON.parse(msg.text);
    if (fields.kind !== 'untrusted_chat_data') continue;
    for (const row of Array.isArray(fields.history)
      ? fields.history
      : fields.history
        ? [fields.history]
        : [])
      add('history' + ++history, row);
    if (
      fields.reply &&
      (ready.metadata?.reply === 'included' || ready.metadata?.reply === 'truncated')
    )
      add('reply', fields.reply);
    if (fields.initiativeEvidence) add('initiativeEvidence', fields.initiativeEvidence);
    if (fields.current) add('current', fields.current);
  }
  return material;
}
/** Сеанс привязан к реальному автору исходного сообщения и к поколению очереди. */
export function applicationTools(
  storage: Storage,
  adapter: ChannelAdapter,
  authorization: Pick<Awaited<ReturnType<typeof createAuthorizationService>>, 'context'>,
  auxiliaryClient: LlmClient,
): NonNullable<AgentLoopQueueOptions['tools']> {
  const members = participantRegistryStore(storage),
    addresses = addressPreferenceStore(storage);
  return async ({ work, prepared, attempts, settings, modelInputLimit }) => {
    if (!work.route || !prepared.metadata || work.route.kind === 'initiative') return;
    const scope = work.scope,
      ids = new Set<number>(),
      guards: (() => boolean)[] = [];
    const current = await storage.contextMessages.get(scope, work.messageId);
    if (!current || current.role !== 'user' || !work.isCurrent()) return;
    const material = exposedMaterial(prepared);
    const anchors = new Map<string, UserId>([['current', current.userId]]);
    const replyId = material.get('reply')?.messageIds[0];
    if (replyId !== undefined) {
      const reply = await storage.contextMessages.get(scope, replyId);
      if (reply?.role === 'user') anchors.set('reply', reply.userId);
    }
    for (const [index, user] of (adapter.mentionedPeople?.(current.text) ?? []).entries())
      anchors.set('mention' + (index + 1), user);
    const principal = authorization.context({ scope, userId: current.userId });
    const context: ToolContext = {
      chatId: scope.chatId,
      userId: current.userId,
      platform: adapter.platform,
      adapter,
      isAdmin: 'unknown',
      authorization: principal,
    };
    const group = work.route.isGroupChat;
    const roster = (interest?: string) => {
      const refs: import('../storage/participant-types').ProfileReadReference[] = [];
      const found = interest ? storage.profileFacts.searchInterests(scope, interest) : undefined;
      if (found) refs.push(found.reference);
      const snapshot = members.publicMembers(scope, work.messageId);
      return {
        complete: snapshot.complete,
        matches: new Set(found?.matches.map((m) => m.userId)),
        describe(user: UserId) {
          const profile = storage.profileFacts.read(scope, user);
          refs.push(profile.reference);
          return {
            sourceIds: profile.sourceIds,
            facts: profile.facts,
            interests: profile.facts
              .filter((f) => f.fieldKey === 'interest' && f.sourceKind === 'self')
              .map((f) => f.value),
          };
        },
        current: () => refs.every((ref) => storage.profileFacts.isCurrent(scope, ref)),
        members: snapshot.rows.map((row) => {
          const address = addresses.resolve(scope, row.user, current.timestamp, group);
          return {
            user: row.user,
            participationRevision: row.participationRevision,
            name: row.name ?? 'Участник',
            present: row.status === 'present',
            ...(address ? { address: address.text } : {}),
            interests: [],
            sourceIds: row.nameId === null ? [] : [row.nameId],
          };
        }),
      };
    };
    const participants = participantTools(
      roster,
      anchors,
      () =>
        context.authorization?.scope.chatId === scope.chatId &&
        context.authorization.scope.generation === scope.generation,
    );
    const subjects = new Set<UserId>();
    const valid = () =>
      guards.every((check) => check()) && (!ids.size || members.sourcesVisible(scope, [...ids]));
    let frame: LlmRequest = { ...prepared.input, signal: work.signal },
      pending: readonly string[] = [],
      parentSteps = 0;
    let helper: ReturnType<typeof createJobDelegation> | undefined;
    const usage: LlmUsage[] = [],
      traces: ReturnType<LoopTools['trace']>[number][] = [];
    const remember = (result: ToolExecution) => {
      for (const user of result.subjectIds ?? []) subjects.add(user);
      for (const id of result.sourceIds ?? []) ids.add(id);
      if (result.current) guards.push(result.current);
    };
    const knownLabels = new Set(prepared.authorLabels ?? []);
    const histories = historyTools({
      principal,
      cutoffId: work.messageId,
      group,
      timezone: prepared.timezone ?? 'UTC',
      read: storage.contextMessages.history,
      author(ref) {
        const user = anchors.get(ref);
        if (user) return { author: user };
        if (group && knownLabels.has(ref) && /^u[1-9]\d*$/.test(ref))
          return { authorNumber: Number(ref.slice(1)) };
      },
    });
    const used = [...(group ? participants.definitions : []), ...histories];
    let budgetExhausted = false;
    const delegate: RuntimeTool = {
      ...delegateDescription,
      description:
        delegateDescription.description +
        ' Источники: current, reply, history1 и далее от старых к новым, delegate:<id вызова>.',
      access: 'read',
      async execute(_args, _ctx, call) {
        if (!helper) throw Error();
        const result = await helper.execute(call);
        return {
          outcome: result.status === 'complete' ? 'success' : 'failed',
          text: delegateFeedback(call.id, result).text,
          sourceIds: result.messageIds,
        };
      },
    };
    const registry = createToolRegistry(
      [...used, delegate],
      context,
      () => work.isCurrent() && valid(),
    );
    const schemas = () => registry.schemas();
    let offered: readonly LlmToolDescription[] = [];
    const session: LoopTools = {
      async schemas(request) {
        // Дополнительные карточки вписываются после выбора схем для базового ввода.
        offered = await schemas();
        if (
          modelInputLimit &&
          estimateRequestInput({ ...request, tools: offered }) > modelInputLimit
        ) {
          // Сохраняем прежний набор инструментов, если новые схемы истории не помещаются.
          offered = offered.filter(
            (tool) => !histories.some((history) => history.name === tool.name),
          );
          if (estimateRequestInput({ ...request, tools: offered }) > modelInputLimit) offered = [];
        }
        return offered;
      },
      current: valid,
      budgetExhausted: () => budgetExhausted,
      helperSteps: () => helper?.helperSteps() ?? 0,
      helperSummary: () => usage,
      beginBatch(request, remaining, steps) {
        frame = request;
        pending = remaining;
        parentSteps = steps;
        helper ??= createJobDelegation({
          work,
          principal: context,
          attempts,
          client: auxiliaryClient,
          signal: request.signal ?? work.signal,
          maxSteps: settings.maxSteps,
          parentSteps: () => parentSteps,
          finalRequest: () => ({ request: frame, pending }),
          startUsage() {
            const slot = usage.push({ input: null, output: null }) - 1;
            return (value) => {
              usage[slot] = value;
            };
          },
          materials: {
            resolve: (ref) => material.get(ref),
            visible: (received) => members.sourcesVisible(scope, received) && valid(),
            allowedTools: () => used.filter((t) => offered.some((s) => s.name === t.name)),
            read: async (call, _signal, fits) => {
              const output = await execute(call, offered, true, fits);
              if (output.budgetExhausted) return 'limit';
              if (output.outcome !== 'success') return;
              return {
                ref: 'read:' + call.id,
                text: output.text,
                messageIds: output.sourceIds ?? [],
              };
            },
          },
        });
      },
      async execute(call, issued) {
        const available =
          modelInputLimit === undefined ? Infinity : modelInputLimit - estimateRequestInput(frame);
        const result = await execute(
          call,
          issued,
          false,
          (text) => toolMessageInputCost(call.id, text) <= available,
        );
        if (result.budgetExhausted) budgetExhausted = true;
        return result.text;
      },
      subjectIds: () => [...subjects],
      sourceIds: () => [...ids],
      trace: () => traces,
      labels: () => [...knownLabels, ...participants.labels()],
    };
    async function execute(
      call: import('../llm/types').LlmToolCall,
      issued: readonly LlmToolDescription[],
      readOnly: boolean,
      fits: (text: string, ceiling?: number) => boolean,
    ) {
      const started = performance.now();
      const reply = await registry.execute(call, issued, readOnly, fits);
      const result = fitsToolEnvelope(call.id, reply.text)
        ? reply
        : {
            text: '{"status":"incomplete","gaps":["Результат превысил допустимый размер."]}',
            outcome: 'failed' as const,
          };
      for (const label of result.authorLabels ?? []) knownLabels.add(label);
      remember(result);
      traces.push({
        name: /^\w[\w.-]{0,63}$/.test(call.name) ? call.name : 'unknown',
        outcome: result.outcome,
        bytes: Buffer.byteLength(result.text),
        durationMs: Math.floor(performance.now() - started),
      });
      return result;
    }
    return session;
  };
}
