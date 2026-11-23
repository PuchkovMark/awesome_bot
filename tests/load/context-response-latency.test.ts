import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import type { ConnectionScope, IncomingMessage } from '../../src/contracts/index';
import {
  createAgentLoopQueue,
  createMessageRouter,
  createPublicationService,
} from '../../src/core/index';
import { createContextPreparation } from '../../src/core/prepare-context';
import { responseRateConfig } from '../../src/core/chat-limits/response-rate-config';
import { installStarterPersonas } from '../../src/storage/catalog-admin';
import { queueBackend, registerQueue } from '../../src/storage/queue-registry';
import { scopeFor } from '../helpers/connection-scope';
import { contextCapabilities, contextFixture } from '../helpers/context';
import { recordQueueLoad, summarizeDurations } from '../helpers/queue-load-fixture';

const historySize = 100;
const inputBudgetTokens = 32000;
const modelContextTokens = 64000;
const nowMs = Date.parse('2026-11-23T00:00:00Z');
const delaysMs = { model: 25, replyCheck: 2, send: 8 };
const queueConfig = { maxQueuedPerChat: 3 };
const limits = { userRequests: 3, chatRequests: 10 };
const responseRate = responseRateConfig();
const responseText = 'Ответ стенда.';
const stages = [
  'received',
  'started',
  'preparationStarted',
  'preparationEnded',
  'modelStarted',
  'modelEnded',
  'publicationStarted',
  'confirmed',
] as const;

type Profile = 'single' | 'sameChat' | 'parallelChats';
type Stage = (typeof stages)[number];
interface Timeline {
  readonly message: IncomingMessage;
  readonly times: Partial<Record<Stage, number>>;
  readonly publicationFinished: ReturnType<typeof Promise.withResolvers<void>>;
  journalId?: number;
  jobId?: number;
  historyCount?: number;
}

async function measureTrial(profile: Profile) {
  const fixture = await contextFixture();
  const storage = fixture.storage;
  const scopes: ConnectionScope[] = [fixture.scope];
  const waiting = new Map<string, Timeline[]>();
  const running = new Map<string, Timeline>();
  const backend = queueBackend(storage);
  registerQueue(storage, {
    ...backend,
    take(...args) {
      const work = backend.take(...args);
      if (work) {
        const timeline = waiting.get(work.scope.chatId)?.shift();
        if (!timeline) throw Error('Для взятого задания нет метки приёма');
        timeline.times.started = performance.now();
        timeline.journalId = work.messageId;
        timeline.jobId = work.id;
        running.set(work.scope.chatId, timeline);
      }
      return work;
    },
  });

  const preparation = createContextPreparation({
    storage,
    config: { modelContextTokens, inputBudgetTokens },
    now: () => nowMs,
    capabilities: async (scope) => contextCapabilities(scope.chatId),
    sessionId: (scope) => Buffer.from(scope.chatId).toString('hex'),
  });
  const publication = createPublicationService({
    storage,
    responseBudget: () => queue.responseBudget,
    port: {
      async canReply() {
        await delay(delaysMs.replyCheck);
        return true;
      },
      async publish(request) {
        const timeline = running.get(request.scope.chatId)!;
        expect(request.kind).toBe('answer');
        expect(request.text).toBe(responseText);
        expect(request.replyToMessageId).toBe(timeline.message.messageId);
        if (!(await request.allow()) || !request.beforeSend?.()) return { kind: 'failed' };
        await delay(delaysMs.send);
        const confirmedAt = performance.now();
        request.confirmPart({
          messageId: `sent-${timeline.message.messageId}`,
          userId: 'vk:bot',
          authorName: 'Бот',
          text: request.text,
          timestamp: nowMs,
          replyToMessageId: timeline.message.messageId,
        });
        timeline.times.confirmed = confirmedAt;
        return { kind: 'delivered', confirmedParts: 1 };
      },
    },
  });
  const queue = createAgentLoopQueue({
    storage,
    modelName: 'synthetic-model',
    tracing: { messageRetentionDays: 30 },
    config: queueConfig,
    limits,
    responseRate,
    async prepare(work) {
      const timeline = running.get(work.scope.chatId)!;
      expect(work.messageId).toBe(timeline.journalId);
      timeline.times.preparationStarted = performance.now();
      const result = await preparation.prepare(work);
      timeline.times.preparationEnded = performance.now();
      if (result.kind === 'ready') timeline.historyCount = result.metadata.messageIds.length - 1;
      return result;
    },
    client: {
      async complete(input) {
        const timeline = running.get(Buffer.from(input.sessionId, 'hex').toString())!;
        expect(timeline.times.modelStarted).toBeUndefined();
        timeline.times.modelStarted = performance.now();
        await delay(delaysMs.model);
        timeline.times.modelEnded = performance.now();
        return { kind: 'complete', text: responseText, usage: { input: 1, output: 1 } };
      },
    },
    async onSettled(work, completion) {
      const timeline = running.get(work.scope.chatId)!;
      timeline.times.publicationStarted = performance.now();
      try {
        await publication.onSettled(work, completion);
      } finally {
        running.delete(work.scope.chatId);
        timeline.publicationFinished.resolve();
      }
    },
  });

  try {
    installStarterPersonas(storage, 0);
    if (profile === 'parallelChats') {
      for (const chatId of ['vk:latency-b', 'vk:latency-c']) {
        const scope = scopeFor(storage, chatId);
        await storage.chats.create(scope, {
          enabled: true,
          responseMode: 'normal',
          createdAt: 0,
          timezone: 'UTC',
        });
        scopes.push(scope);
      }
    }
    for (const scope of scopes) {
      waiting.set(scope.chatId, []);
      for (let index = 0; index < historySize; index++) {
        await storage.messages.append(scope, {
          chatId: scope.chatId,
          messageId: `history-${index}`,
          userId: 'vk:u',
          authorName: 'Имя',
          role: 'user',
          text: 'Короткая предыдущая реплика.',
          timestamp: nowMs,
        });
      }
    }
    await queue.start();
    const router = createMessageRouter({ storage, queue, onQueueFull: publication.queueFull });
    const requestScopes =
      profile === 'sameChat' ? [fixture.scope, fixture.scope, fixture.scope] : scopes;
    const timelines: Timeline[] = [];
    async function receive(scope: ConnectionScope, index: number) {
      const timeline: Timeline = {
        message: {
          kind: 'message',
          chatId: scope.chatId,
          messageId: `request-${index}`,
          userId: 'vk:u',
          authorName: 'Имя',
          text: 'Что было раньше?',
          timestamp: nowMs,
          attachments: [],
          isBot: false,
          isAdmin: false,
          isGroupChat: true,
          isMentioned: true,
          isReplyToBot: false,
        },
        times: {},
        publicationFinished: Promise.withResolvers<void>(),
      };
      timelines.push(timeline);
      waiting.get(scope.chatId)!.push(timeline);
      timeline.times.received = performance.now();
      const { admission } = await router.receive(scope, timeline.message);
      expect(admission?.status).toBe('queued');
    }
    if (profile === 'sameChat') {
      for (const [index, scope] of requestScopes.entries()) await receive(scope, index);
    } else {
      await Promise.all(requestScopes.map(receive));
    }
    const deadline = new AbortController();
    try {
      await Promise.race([
        Promise.all(timelines.map((item) => item.publicationFinished.promise)),
        delay(10000, undefined, { signal: deadline.signal }).then(() => {
          throw Error('Стенд не подтвердил публикацию');
        }),
      ]);
    } finally {
      deadline.abort();
    }

    const results = [];
    for (const [index, timeline] of timelines.entries()) {
      const [
        received,
        started,
        preparationStarted,
        preparationEnded,
        modelStarted,
        modelEnded,
        publicationStarted,
        confirmed,
      ] = stages.map((stage) => {
        const time = timeline.times[stage];
        if (time === undefined) throw Error(`Пропущен этап ${stage}`);
        return time;
      }) as [number, number, number, number, number, number, number, number];
      expect(stages.map((stage) => timeline.times[stage])).toEqual(
        stages.map((stage) => timeline.times[stage]).sort((a, b) => a! - b!),
      );
      const scope = requestScopes[index]!;
      expect(await storage.traces.get(scope, timeline.jobId!)).toMatchObject({
        outcome: 'completed',
        payload: {
          context: { persona: { version: { key: 'max', version: 1 } } },
          summary: { attempts: 1 },
          publication: { status: 'delivered' },
        },
      });
      expect(await storage.messages.list(scope, { limit: 8 })).toContainEqual(
        expect.objectContaining({
          messageId: `sent-${timeline.message.messageId}`,
          role: 'assistant',
          text: responseText,
        }),
      );
      expect(timeline.historyCount).toBe(historySize + (profile === 'sameChat' ? index : 0));
      const result = {
        historyCount: timeline.historyCount!,
        totalMs: confirmed - received,
        queueMs: started - received,
        preparationMs: preparationEnded - preparationStarted,
        modelMs: modelEnded - modelStarted,
        publicationMs: confirmed - publicationStarted,
        otherMs:
          preparationStarted -
          started +
          (modelStarted - preparationEnded) +
          (publicationStarted - modelEnded),
      };
      expect(result.totalMs).toBeCloseTo(
        result.queueMs +
          result.preparationMs +
          result.modelMs +
          result.publicationMs +
          result.otherMs,
        6,
      );
      results.push(result);
    }
    if (profile === 'sameChat') {
      for (let index = 1; index < timelines.length; index++) {
        expect(timelines[index]!.times.started).toBeGreaterThan(
          timelines[index - 1]!.times.confirmed!,
        );
      }
    }
    if (profile === 'parallelChats') {
      expect(Math.max(...timelines.map((item) => item.times.started!))).toBeLessThan(
        Math.min(...timelines.map((item) => item.times.confirmed!)),
      );
    }
    return results;
  } finally {
    try {
      await queue.stop();
    } finally {
      await storage.close();
    }
  }
}

test.each(['single', 'sameChat', 'parallelChats'] as const)(
  'путь до первой доставки, профиль=%s',
  async (profile) => {
    const warmupTrials = 2;
    const measuredTrials = 12;
    const samples: Awaited<ReturnType<typeof measureTrial>> = [];
    for (let trial = 0; trial < warmupTrials + measuredTrials; trial++) {
      const results = await measureTrial(profile);
      if (trial >= warmupTrials) samples.push(...results);
      globalThis.gc?.();
    }
    await recordQueueLoad({
      benchmark: 'contextResponseLatency',
      revision: process.env.AWESOME_CONTEXT_BENCHMARK_REVISION ?? 'working-tree',
      node: process.version,
      profile,
      nowMs,
      historySize,
      selectedHistory: [...new Set(samples.map(({ historyCount }) => historyCount))],
      inputBudgetTokens,
      modelContextTokens,
      delaysMs,
      queueConfig,
      limits,
      responseRate,
      gcOutsideMeasurement: !!globalThis.gc,
      warmupTrials,
      measuredTrials,
      samples: samples.length,
      metrics: Object.fromEntries(
        (
          ['totalMs', 'queueMs', 'preparationMs', 'modelMs', 'publicationMs', 'otherMs'] as const
        ).map((key) => [key, summarizeDurations(samples.map((sample) => sample[key]))]),
      ),
    });
  },
);

test('карточки читают профили только окна при росте состава беседы', async () => {
  const { contextParticipantCards } = await import('../../src/app/context-participant-cards');
  const { createParticipantCardComposer } =
    await import('../../src/core/context/participant-cards');
  const { disclosureStore } = await import('../../src/storage/chat-disclosure-store');
  const { participantRegistryStore } = await import('../../src/storage/participant-registry');
  const { profileNotice } = await import('../helpers/profile-fact-fixture');
  const f = await contextFixture('vk:latency-cards');
  const { storage, scope } = f;
  const readers = contextParticipantCards(storage);
  const people = Array.from({ length: 12 }, (_, index) => `vk:${41 + index}` as const);
  try {
    const disclosures = disclosureStore(storage);
    const version = disclosures.register(profileNotice, nowMs - 2000);
    const pending = disclosures.ensure(scope, 'introduction', version);
    const claim = disclosures.claim(scope, pending.id, profileNotice.profileNotice, nowMs - 1000)!;
    expect(disclosures.finish(scope, claim, 'delivered', nowMs - 1000, null, 'cards')).toBe(true);
    for (let i = 0; i < historySize; i++) {
      const userId = people[i % people.length]!;
      const { id } = await f.put('source-' + i, 'Короткая предыдущая реплика.', {
        userId,
        isGroupChat: true,
        senderBot: false,
        timestamp: nowMs,
      });
      if (i < people.length)
        await storage.authorization.transaction(scope, (tx) => {
          expect(
            tx.changeProfileFact(userId, {
              subjectId: userId,
              messageId: id,
              change: {
                kind: 'set',
                fieldKey: 'interest',
                value: 'Гончарное дело',
                reliability: 'confirmed',
              },
            }),
          ).toBe('recorded');
        });
    }
    const current = await f.put('current', 'Вопрос стенда', {
      userId: people[0],
      senderBot: false,
      isGroupChat: true,
      timestamp: nowMs,
    });
    const reads: string[] = [];
    const options = {
      ...f.options,
      config: { modelContextTokens, inputBudgetTokens },
      now: () => nowMs,
    };
    const baseline = createContextPreparation({ ...options, storage });
    const extended = createContextPreparation({
      ...options,
      storage,
      participantCards: {
        ...readers,
        read(...input) {
          reads.push(input[1]);
          return readers.read(...input);
        },
      },
    });
    const tools = [
      {
        name: 'participant',
        description: 'Описание схемы стенда',
        parameters: { type: 'object' as const },
      },
    ];
    const warmup = 2,
      measured = 12;
    const silent = 2000;
    const members = participantRegistryStore(storage);
    const results = [];
    for (const silentParticipants of [0, silent]) {
      if (silentParticipants)
        for (let i = 0; i < silentParticipants; i++)
          members.observe(scope, {
            kind: 'membership',
            chatId: scope.chatId,
            change: 'joined',
            subjectId: `vk:${1000 + i}`,
            actorId: null,
            timestamp: nowMs,
          });
      const durations = { baseline: [] as number[], cards: [] as number[] };
      for (let i = 0; i < warmup + measured; i++) {
        let baseData: unknown;
        for (const [key, preparation] of [
          ['baseline', baseline],
          ['cards', extended],
        ] as const) {
          reads.length = 0;
          const began = performance.now();
          const ready = await preparation.prepare(f.work(current.id));
          if (ready.kind !== 'ready') throw Error('Стенд не собрал запрос.');
          const input = { ...ready.input, tools };
          const sent = ready.participantCards
            ? createParticipantCardComposer(ready.participantCards)(input)
            : { request: input, used: [] };
          const elapsed = performance.now() - began;
          if (i >= warmup) durations[key].push(elapsed);
          const { participantCards, ...rest } = JSON.parse(sent.request.messages[0]!.text!);
          if (key === 'baseline') {
            baseData = rest;
            expect(reads).toEqual([]);
            expect(participantCards).toBeUndefined();
          } else {
            expect(rest).toEqual(baseData);
            expect(participantCards).toHaveLength(people.length);
            expect(reads.slice().sort()).toEqual(people.slice().sort());
          }
        }
      }
      results.push({
        silentParticipants,
        windowParticipants: people.length,
        profileReads: reads.length,
        baseline: summarizeDurations(durations.baseline),
        cards: summarizeDurations(durations.cards),
      });
    }
    await recordQueueLoad({
      benchmark: 'participantContextCards',
      historySize,
      modelContextTokens,
      results,
    });
  } finally {
    await storage.close();
  }
});
