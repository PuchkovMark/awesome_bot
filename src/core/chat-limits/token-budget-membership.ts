import type { ChannelAdapter, ConnectionScope, HumanMembership } from '../../contracts/index';
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
    let result: HumanMembership;
    try {
      result = await read(scope, signal);
    } catch {
      result = { complete: false };
    }
    if (signal.aborted || !isCurrent()) return false;
    return store.finishObservation(scope, observation, result);
  };
}
