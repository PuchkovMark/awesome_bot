import type { ConnectionScope, UserId } from '../contracts/index';
import { readDisclosureGate } from './chat-disclosure-store';
import type { LifecycleBackend } from './lifecycle-store';
import type {
  ProfileReadReference,
  PublicInterestMatches,
  PublicProfile,
  PublicProfileFact,
} from './participant-types';
import { interestKey, selectPublicFacts, type ProfileQuery } from './profile-fact-selection';
import { compositeId, requireInput } from './validation';

function publicFact(row: PublicProfileFact): PublicProfileFact {
  const { fieldKey, value, sourceKind, reliability } = row;
  return Object.freeze({ fieldKey, value, sourceKind, reliability });
}

export function createProfileFactReader(lifecycle: LifecycleBackend) {
  const read = (scope: ConnectionScope, query: ProfileQuery) =>
    lifecycle.transaction(scope, (db) => {
      const revision = lifecycle.revision(scope);
      const facts = selectPublicFacts(db, scope, query, Date.now());
      const signature = JSON.stringify([
        facts.length === 0 ? null : readDisclosureGate(db, scope).version,
        ...facts.map(({ row, restrictionId }) => [row.id, restrictionId]),
      ]);
      return { revision, facts, signature };
    });
  const references = new WeakMap<
    ProfileReadReference,
    {
      readonly chatId: ConnectionScope['chatId'];
      readonly generation: number;
      readonly revision: number;
      readonly query: ProfileQuery;
      readonly signature: string;
    }
  >();
  function snapshot(scope: ConnectionScope, query: ProfileQuery) {
    const { revision, facts, signature } = read(scope, query);
    const reference = Object.freeze({}) as ProfileReadReference;
    references.set(reference, {
      chatId: scope.chatId,
      generation: scope.generation,
      revision,
      query,
      signature,
    });
    return { facts, reference };
  }
  return Object.freeze({
    read(scope: ConnectionScope, subjectId: UserId): PublicProfile {
      compositeId(subjectId);
      requireInput(subjectId.split(':')[0] === scope.chatId.split(':')[0]);
      const { facts, reference } = snapshot(scope, { kind: 'profile', subjectId });
      return Object.freeze({
        facts: Object.freeze(facts.map(({ row }) => publicFact(row))),
        reference,
      });
    },
    searchInterests(scope: ConnectionScope, interest: string): PublicInterestMatches {
      const { facts, reference } = snapshot(scope, {
        kind: 'interest',
        interest: interestKey(interest),
      });
      const matches = facts.map(({ row }) =>
        Object.freeze({ userId: row.userId, fact: publicFact(row) }),
      );
      return Object.freeze({ matches: Object.freeze(matches), reference });
    },
    isCurrent(scope: ConnectionScope, reference: ProfileReadReference): boolean {
      const saved = references.get(reference);
      if (saved?.chatId !== scope.chatId || saved.generation !== scope.generation) return false;
      try {
        const current = read(scope, saved.query);
        return current.revision === saved.revision && current.signature === saved.signature;
      } catch {
        return false;
      }
    },
  });
}
