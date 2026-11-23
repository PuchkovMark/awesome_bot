import type { ContextCardReader } from '../core/context/participant-cards';
import { addressPreferenceStore } from '../storage/address-preference-store';
import type { Storage } from '../storage/types';

export function contextParticipantCards(storage: Storage): ContextCardReader {
  const profiles = storage.profileFacts;
  const addresses = addressPreferenceStore(storage);
  return {
    read(scope, user, at, group) {
      if (!group && scope.chatId !== user) return { facts: [] };
      const facts = profiles.cardFacts(scope, user);
      const address = addresses.resolveForCard(scope, user, at, group);
      return { facts, ...(address ? { address } : {}) };
    },
    current(scope, refs) {
      const facts = refs.flatMap((ref) => (ref.kind === 'fact' ? [ref.value] : []));
      if (!profiles.cardFactsCurrent(scope, facts)) return false;
      try {
        return refs.every((ref) => ref.kind === 'fact' || addresses.current(scope, ref.value, ref));
      } catch {
        return false;
      }
    },
  };
}
