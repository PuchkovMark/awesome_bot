import type { AddressPreferenceReference, ConnectionScope, UserId } from '../../contracts/index';
import type { LlmRequest } from '../../llm/types';
import type { ContextCardFact, ContextCardFactReference } from '../../contracts/profile-facts';
import { estimateRequestInput } from './budget';
import { appendParticipantCards, serializeParticipantCard } from './format';

export interface CardCandidate {
  readonly userId: UserId;
  readonly author: string;
  readonly authorLabel?: string;
  readonly shownAddress?: string;
  readonly timestamp: number;
  readonly id: number;
}

export interface CardAddress {
  readonly text: string;
  readonly reference: AddressPreferenceReference;
  readonly sourceId?: number;
}

export type CardReference =
  | { readonly kind: 'fact'; readonly value: ContextCardFactReference }
  | {
      readonly kind: 'address';
      readonly value: AddressPreferenceReference;
      readonly sourceId?: number;
    };

export interface ContextCardReader {
  read(
    scope: ConnectionScope,
    author: UserId,
    at: number,
    group: boolean,
  ): {
    readonly facts: readonly ContextCardFact[];
    readonly address?: CardAddress;
  };
  current(scope: ConnectionScope, refs: readonly CardReference[]): boolean;
}

export interface PreparedCards {
  readonly candidates: readonly CardCandidate[];
  readonly messageIndex: number;
  readonly modelContextTokens: number;
  read(user: UserId): ReturnType<ContextCardReader['read']>;
  current(refs: readonly CardReference[]): boolean;
}

export interface UsedCard {
  readonly owner: UserId;
  readonly refs: readonly CardReference[];
  readonly sourceIds: readonly number[];
}

export function createParticipantCardComposer(plan: PreparedCards, modelInputLimit?: number) {
  const cached = new Map<UserId, ReturnType<ContextCardReader['read']>>();
  return (request: LlmRequest): { request: LlmRequest; used: readonly UsedCard[] } => {
    const target = request.messages[plan.messageIndex];
    const limit = Math.min(
      modelInputLimit ?? Number.POSITIVE_INFINITY,
      plan.modelContextTokens - request.maxOutputTokens,
    );
    if (target?.role !== 'user' || !target.text) return { request, used: [] };
    const base = estimateRequestInput(request);
    let free = limit - base - Buffer.byteLength(',"participantCards":[]');
    const parts: string[] = [];
    const used: UsedCard[] = [];
    for (const candidate of plan.candidates) {
      const { userId, author, authorLabel } = candidate;
      const minimum = serializeParticipantCard({ author, authorLabel });
      if (free < Buffer.byteLength(minimum) + Number(parts.length > 0)) continue;
      let data = cached.get(userId);
      if (!data) {
        try {
          data = plan.read(userId);
        } catch {
          data = { facts: [] };
        }
        cached.set(userId, data);
      }
      const address = data.address;
      const usefulAddress =
        address && address.text !== author && address.text !== candidate.shownAddress;
      for (let count = Math.min(2, data.facts.length); count >= 0; count--) {
        if (count === 0 && !usefulAddress) break;
        const facts = data.facts.slice(0, count);
        const card = serializeParticipantCard({
          author,
          authorLabel,
          ...(address ? { addressForm: address.text } : {}),
          ...(count ? { facts: facts.map(({ value }) => value) } : {}),
        });
        const bytes = Buffer.byteLength(card) + Number(parts.length > 0);
        if (bytes > free) continue;
        parts.push(card);
        free -= bytes;
        used.push({
          owner: userId,
          refs: [
            ...facts.map(({ reference }) => ({ kind: 'fact' as const, value: reference })),
            ...(address
              ? [
                  {
                    kind: 'address' as const,
                    value: address.reference,
                    ...(address.sourceId === undefined ? {} : { sourceId: address.sourceId }),
                  },
                ]
              : []),
          ],
          sourceIds: [
            ...facts.flatMap(({ sourceIds }) => sourceIds),
            ...(address?.sourceId === undefined ? [] : [address.sourceId]),
          ],
        });
        break;
      }
    }
    if (!parts.length) return { request, used };
    const messages = request.messages.slice();
    messages[plan.messageIndex] = { ...target, text: appendParticipantCards(target.text, parts) };
    const result = { ...request, messages };
    return estimateRequestInput(result) <= limit
      ? { request: result, used }
      : { request, used: [] };
  };
}
