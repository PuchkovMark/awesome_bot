import type { ConnectionScope } from '../../contracts/lifecycle';
import type { LlmRequest } from '../../llm/types';
import { estimateRequestInput } from './budget';
import type { ContextConfig } from './config';
import { appendPassport } from './format';
import type {
  PassportEntry,
  PassportRevision,
  PassportSection,
} from '../../contracts/chat-passport';
import { unquotedText } from '../author-text';

const signs = [
  [
    'rules',
    /(?:^| )(?:правил\p{L}*|разрешен\p{L}*|запрещ\p{L}*|реклам\p{L}*|спам\p{L}*|модерац\p{L}*|нарушен\p{L}*)(?: |$)|(?:^| )можно(?: ли)? (?:здесь|тут|сюда|в (?:беседе|чате))(?: |$)/u,
  ],
  [
    'glossary',
    /(?:^| )(?:глоссар\p{L}*|значение слова|что (?:значит|означает|понимают)|как (?:у нас )?понимать|местн\p{L}* (?:слово|выражение|термин)|расшифруй\p{L}*)(?: |$)/u,
  ],
  [
    'topic',
    /(?:^| )(?:тем[ауы] (?:(?:этой|этого) )?(?:бесед\p{L}*|чат\p{L}*)|о чем (?:этот чат|эта беседа|здесь говорят)|что (?:у нас |здесь )?обсуждают)(?: |$)/u,
  ],
  [
    'traditions',
    /(?:^| )(?:традици\p{L}*|обыча\p{L}*|ритуал\p{L}*|как (?:здесь|у нас) принято)(?: |$)/u,
  ],
  [
    'events',
    /(?:^| )(?:событи\p{L}*|мероприяти\p{L}*|когда (?:будет |следующая )?встреча|что важного (?:здесь |у нас )?произошло)(?: |$)/u,
  ],
] as const satisfies readonly (readonly [PassportSection, RegExp])[];

export function passportCandidates(text: string): readonly PassportSection[] {
  const words =
    unquotedText(text)
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(' ') ?? '';
  return signs.filter(([, match]) => match.test(words)).map(([section]) => section);
}

export interface PassportContextReader {
  read(scope: ConnectionScope): readonly PassportEntry[];
  current(scope: ConnectionScope, revisions: readonly PassportRevision[]): boolean;
}

export interface PreparedPassport {
  readonly entries: readonly PassportEntry[];
  readEntries(): readonly PassportEntry[];
  readonly messageIndex: number;
  readonly inputBudgetTokens: number;
  readonly modelContextTokens: number;
  current(revisions: readonly PassportRevision[]): boolean;
}

export function preparePassport(
  reader: PassportContextReader,
  scope: ConnectionScope,
  text: string,
  messageIndex: number,
  config: ContextConfig,
): PreparedPassport | undefined {
  const candidates = passportCandidates(text);
  if (!candidates.length) return undefined;
  function readEntries() {
    const snapshot = reader.read(scope);
    return candidates.map(
      (section) =>
        snapshot.find((entry) => entry.section === section) ?? { section, revision: 0, text: null },
    );
  }
  return {
    entries: readEntries(),
    readEntries,
    messageIndex,
    inputBudgetTokens: config.inputBudgetTokens,
    modelContextTokens: config.modelContextTokens,
    current: (revisions) => reader.current(scope, revisions),
  };
}

export function composePassport(
  plan: PreparedPassport,
  request: LlmRequest,
  modelInputLimit = Number.POSITIVE_INFINITY,
): { request: LlmRequest; used: readonly PassportRevision[]; estimatedTokens: number } {
  const empty = { request, used: [], estimatedTokens: 0 };
  const target = request.messages[plan.messageIndex];
  if (target?.role !== 'user' || !plan.entries.some(({ text }) => text)) return empty;
  const base = estimateRequestInput(request);
  const allowance = Math.min(
    Math.floor(plan.inputBudgetTokens / 10),
    1024,
    Math.min(modelInputLimit, plan.modelContextTokens - request.maxOutputTokens) - base,
  );
  if (allowance <= 0) return empty;
  const used: PassportRevision[] = [];
  let blocks: Partial<Record<PassportSection, string>> = {};
  let composed = request;
  let estimatedTokens = 0;
  for (const { section, revision, text } of plan.entries) {
    if (!text) continue;
    const candidate = { ...blocks, [section]: text };
    const combined = appendPassport(target.text, candidate);
    if (combined === undefined) return empty;
    const messages = request.messages.slice();
    messages[plan.messageIndex] = { ...target, text: combined };
    const tentative = { ...request, messages };
    const added = estimateRequestInput(tentative) - base;
    if (added > allowance) continue;
    blocks = candidate;
    composed = tentative;
    estimatedTokens = added;
    used.push({ section, revision });
  }
  return { request: composed, used, estimatedTokens };
}
