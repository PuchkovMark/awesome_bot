import type { ChannelAdapter, ConnectionScope } from '../../contracts/index';
import { tokenBudgetStore } from '../../storage/token-budget-store';
import type { Storage } from '../../storage/index';

export function createTokenBudgetMembership(
  storage: Storage,
  read: NonNullable<ChannelAdapter['humanMembership']>,
) {
  const store = tokenBudgetStore(storage);
  return async (scope: ConnectionScope, signal: AbortSignal, isCurrent: () => boolean) => {
    if (signal.aborted || !isCurrent()) return false;
    const observation = store.beginObservation(scope);
    const result = await read(scope, signal);
    if (!result.complete || signal.aborted || !isCurrent()) return false;
    return store.confirmPeople(scope, observation, result.people);
  };
}
