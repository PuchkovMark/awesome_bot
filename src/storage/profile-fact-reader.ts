import type { Database } from 'better-sqlite3';
import { historyBounds } from './history-retention-store';
import type { ConnectionScope, UserId } from '../contracts/index';
import { readDisclosureGate } from './chat-disclosure-store';
import { readDeparture } from './participant-departures';
import type { LifecycleBackend } from './lifecycle-store';
import type {
  ContextCardFact,
  ContextCardFactReference,
  ProfileReadReference,
  PublicInterestMatches,
  PublicProfile,
  PublicProfileFact,
} from './participant-types';
import {
  interestKey,
  selectPublicFacts,
  sourcePriority,
  type ProfileQuery,
} from './profile-fact-selection';
import { compositeId, requireInput } from './validation';

function publicFact(row: PublicProfileFact): PublicProfileFact {
  const { fieldKey, value, sourceKind, reliability } = row;
  return Object.freeze({ fieldKey, value, sourceKind, reliability });
}

type SelectedFact = ReturnType<typeof selectPublicFacts>[number];

function sourceFor(db: Database, scope: ConnectionScope, row: SelectedFact['row'], now: number) {
  if (row.sourceMessageId === null) return null;
  const bounds = historyBounds(db, scope.chatId, now);
  return (
    (db
      .prepare(
        `SELECT id FROM personal_visible_messages
    WHERE chat_id=? AND platform_message_id=? AND id>? AND timestamp>?`,
      )
      .pluck()
      .get(scope.chatId, row.sourceMessageId, bounds.clearedThrough, bounds.expiredThrough) as
      number | undefined) ?? null
  );
}

function compareFacts(left: SelectedFact, right: SelectedFact) {
  const a = left.row;
  const b = right.row;
  return (
    sourcePriority[b.sourceKind] - sourcePriority[a.sourceKind] ||
    (b.sourceAt ?? 0) - (a.sourceAt ?? 0) ||
    Buffer.compare(Buffer.from(b.eventKey ?? ''), Buffer.from(a.eventKey ?? '')) ||
    a.id - b.id
  );
}

export function createProfileFactReader(lifecycle: LifecycleBackend) {
  const cardReferences = new WeakMap<
    ContextCardFactReference,
    {
      readonly chat: ConnectionScope['chatId'];
      readonly generation: number;
      readonly revision: number;
      readonly disclosure: number | null;
      readonly participation: number;
      readonly subject: UserId;
      readonly fact: number;
      readonly restriction: number | null;
      readonly source: number | null;
    }
  >();
  const read = (scope: ConnectionScope, query: ProfileQuery) =>
    lifecycle.transaction(scope, (db) => {
      const revision = lifecycle.revision(scope);
      const facts = selectPublicFacts(db, scope, query, Date.now());
      const participation = new Map<UserId, number>();
      const factVersions = facts.map(({ row, restrictionId }) => {
        let version = participation.get(row.userId);
        if (version === undefined) {
          version = readDeparture(db, scope, row.userId)?.revision ?? 0;
          participation.set(row.userId, version);
        }
        return [row.id, restrictionId, version];
      });
      const signature = JSON.stringify([
        facts.length === 0 ? null : readDisclosureGate(db, scope).version,
        ...factVersions,
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
    cardFacts(scope: ConnectionScope, subjectId: UserId): readonly ContextCardFact[] {
      compositeId(subjectId);
      requireInput(subjectId.split(':')[0] === scope.chatId.split(':')[0]);
      return lifecycle.transaction(scope, (db) => {
        const now = Date.now();
        const selected = selectPublicFacts(db, scope, { kind: 'profile', subjectId }, now)
          .sort(compareFacts)
          .slice(0, 2);
        if (!selected.length) return [];
        const revision = lifecycle.assertScope(db, scope).revision;
        const disclosure = readDisclosureGate(db, scope).version;
        const participation = readDeparture(db, scope, subjectId)?.revision ?? 0;
        return selected.map(({ row, restrictionId }) => {
          const source = sourceFor(db, scope, row, now);
          const reference = Object.freeze({}) as ContextCardFactReference;
          cardReferences.set(reference, {
            chat: scope.chatId,
            generation: scope.generation,
            revision,
            disclosure,
            participation,
            subject: subjectId,
            fact: row.id,
            restriction: restrictionId,
            source,
          });
          return Object.freeze({
            value: publicFact(row),
            reference,
            sourceIds: Object.freeze(source === null ? [] : [source]),
          });
        });
      });
    },
    cardFactsCurrent(scope: ConnectionScope, refs: readonly ContextCardFactReference[]): boolean {
      if (!refs.length) return true;
      try {
        return lifecycle.transaction(scope, (db) => {
          const revision = lifecycle.assertScope(db, scope).revision;
          const disclosure = readDisclosureGate(db, scope).version;
          const now = Date.now();
          const selected = new Map<UserId, SelectedFact[]>();
          return refs.every((ref) => {
            const saved = cardReferences.get(ref);
            if (
              !saved ||
              saved.chat !== scope.chatId ||
              saved.generation !== scope.generation ||
              saved.revision !== revision ||
              saved.disclosure !== disclosure ||
              saved.participation !== (readDeparture(db, scope, saved.subject)?.revision ?? 0)
            )
              return false;
            let facts = selected.get(saved.subject);
            if (!facts) {
              facts = selectPublicFacts(
                db,
                scope,
                { kind: 'profile', subjectId: saved.subject },
                now,
              );
              selected.set(saved.subject, facts);
            }
            const fact = facts.find(({ row }) => row.id === saved.fact);
            return (
              fact !== undefined &&
              fact.restrictionId === saved.restriction &&
              sourceFor(db, scope, fact.row, now) === saved.source
            );
          });
        });
      } catch {
        return false;
      }
    },
    read(scope: ConnectionScope, subjectId: UserId): PublicProfile {
      compositeId(subjectId);
      requireInput(subjectId.split(':')[0] === scope.chatId.split(':')[0]);
      const { facts, reference } = snapshot(scope, { kind: 'profile', subjectId });
      return Object.freeze({
        sourceIds: Object.freeze(
          facts.flatMap(({ row }) => (row.messageRowId === null ? [] : [row.messageRowId])),
        ),
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
