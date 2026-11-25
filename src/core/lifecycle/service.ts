import { observationOf } from './source';
import type {
  ChatId,
  ConnectionScope,
  ConnectionVersion,
  KnownBoolean,
  UserId,
  LifecycleObservation,
  LifecycleSource,
} from '../../contracts/index';
import type { Storage } from '../../storage/index';
import { StorageError } from '../../storage/errors';
import { lifecycleBackend, type AdministrationInvite } from '../../storage/lifecycle-store';
import { validId } from '../authorization/validation';

export function createLifecycleService(options: {
  readonly storage: Storage;
  readonly ownerId: UserId;
  readonly source: LifecycleSource;
}) {
  if (!validId(options.ownerId)) throw new TypeError('Lifecycle: invalid_owner');
  const ownerId = options.ownerId;
  const source = options.source;
  const backend = lifecycleBackend(options.storage);
  const owners = new WeakMap<object, symbol | undefined>();
  const failedPauses = new Map<ChatId, symbol>();
  type OwnerProof = ReturnType<typeof backend.begin>;

  function requireOwner(userId: UserId) {
    if (userId !== ownerId) throw new TypeError('Lifecycle: forbidden');
  }
  function requirePlatform(platform: string) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(platform)) throw new TypeError('Lifecycle: invalid_platform');
  }
  /** Личность до вызова подтверждает приложение; функция не аутентифицирует VK. */
  function owner(chatId: ChatId, userId: UserId) {
    requireOwner(userId);
    if (!validId(chatId)) throw new TypeError('Lifecycle: forbidden');
    const proof = backend.begin(chatId);
    owners.set(proof, failedPauses.get(chatId));
    return proof;
  }
  function consumeOwner(proof: OwnerProof) {
    if (!proof || !owners.has(proof)) throw new TypeError('Lifecycle: forbidden');
    const pauseAtDecisionStart = owners.get(proof);
    owners.delete(proof);
    if (pauseAtDecisionStart !== failedPauses.get(proof.expected.chatId))
      throw new StorageError('stale_scope');
  }
  function applyDecision(
    proof: OwnerProof,
    decision: 'continue' | 'new',
    selected?: ConnectionVersion,
  ) {
    consumeOwner(proof);
    const scope = backend.ownerDecision(proof, decision, selected);
    failedPauses.delete(scope.chatId);
    return scope;
  }

  return Object.freeze({
    /** Только доверенная входная граница приложения, не параметры модели. */
    current(chatId: ChatId) {
      return backend.current(chatId);
    },
    /** Область приёма действительна до следующей сверки или решения владельца. */
    admissionScope(chatId: ChatId) {
      if (failedPauses.has(chatId)) throw new StorageError('uncertain_connection');
      return backend.current(chatId, true);
    },
    activeChatIds(platform: string) {
      requirePlatform(platform);
      return backend.activeChatIds(platform);
    },
    /** Личность до вызова подтверждает доверенная граница приложения. */
    pausedConnections(platform: string, userId: UserId) {
      requireOwner(userId);
      requirePlatform(platform);
      return backend.pausedConnections(platform);
    },
    requestPausedReset(selected: ConnectionVersion, user: UserId, event: number) {
      requireOwner(user);
      if (failedPauses.has(selected.chatId)) throw new StorageError('stale_scope');
      return backend.resets.request(selected, user, event);
    },
    resetWarningDelivered(user: UserId, code: string, receipt: number) {
      requireOwner(user);
      return backend.resets.delivered(user, code, receipt, Date.now());
    },
    answerPausedReset(user: UserId, code: string, event: number, confirm: boolean) {
      requireOwner(user);
      const row = backend.resets.lookup(user, code);
      if (!row || failedPauses.has(row.chatId)) throw new StorageError('stale_scope');
      if (row.state === 'confirmed' || row.state === 'cancelled')
        return { chatId: row.chatId, state: row.state };
      if (!confirm) {
        backend.resets.cancel(user, code, row, event, Date.now());
        return { chatId: row.chatId, state: 'cancelled' as const };
      }
      const proof = owner(row.chatId, user);
      consumeOwner(proof);
      const scope = backend.ownerDecision(proof, 'new', row, {
        owner: user,
        code,
        event,
        now: Date.now(),
      });
      failedPauses.delete(scope.chatId);
      return { chatId: scope.chatId, state: 'confirmed' as const };
    },
    decidePaused(selected: ConnectionVersion, userId: UserId, decision: 'continue' | 'new') {
      const proof = owner(selected.chatId, userId);
      if (failedPauses.has(selected.chatId)) throw new StorageError('stale_scope');
      return applyDecision(proof, decision, selected);
    },
    isAdmissionCurrent(scope: ConnectionScope) {
      try {
        if (failedPauses.has(scope.chatId)) return false;
        backend.revision(scope);
        return true;
      } catch {
        return false;
      }
    },
    /** Доверенный вход сообщает о возможном изменении подключения. */
    recordConnectionSignal(chatId: ChatId, key?: string, invite?: AdministrationInvite) {
      if (!validId(chatId) || (key !== undefined && (typeof key !== 'string' || !key.trim()))) {
        throw new TypeError('Lifecycle: invalid_signal');
      }
      try {
        const result = backend.applyConnectionSignal(backend.begin(chatId), key, invite);
        if (result.status === 'paused') failedPauses.delete(chatId);
        return result;
      } catch (error) {
        failedPauses.set(chatId, Symbol());
        throw error;
      }
    },
    observeAdminMembership(
      scope: ConnectionScope,
      userId: UserId,
      present: boolean,
      messageId: number,
      at: number,
    ) {
      if (failedPauses.has(scope.chatId)) return false;
      return backend.observeAdminMembership(scope, userId, present, messageId, at);
    },
    async refreshAdministration(
      scope: ConnectionScope,
      observe: (input: ReturnType<typeof backend.administrationInputs>) => Promise<{
        readonly observation: LifecycleObservation;
        readonly communityAdmin: KnownBoolean;
      }>,
    ) {
      if (failedPauses.has(scope.chatId)) return false;
      const proof = backend.begin(scope.chatId);
      const inputs = backend.administrationInputs(scope);
      const result = await observe(inputs);
      if (failedPauses.has(scope.chatId)) return false;
      return backend.applyAdministration(
        proof,
        observationOf(result.observation, scope.chatId.split(':')[0]!),
        result.communityAdmin,
      );
    },
    async verify(
      chatId: ChatId,
      evidence?: 'observation_lost' | 'startup' | 'first_seen',
      guard?: { readonly isCurrent: () => boolean; readonly prepare?: () => Promise<boolean> },
    ): Promise<ReturnType<typeof backend.apply>> {
      if (!validId(chatId)) throw new TypeError('Lifecycle: invalid_chat');
      if (guard && !guard.isCurrent()) return { status: 'stale' };
      let proof = backend.begin(chatId);
      if (evidence !== undefined) {
        const result = backend.apply(
          proof,
          { confidence: 'unavailable', bot: 'unknown' },
          evidence,
        );
        if (result.status === 'uncertain') failedPauses.delete(chatId);
        return result;
      }
      if (guard?.prepare && (!(await guard.prepare()) || !guard.isCurrent())) {
        return { status: 'stale' };
      }
      for (;;) {
        let observation;
        try {
          observation = await source.observe(Object.freeze({ chatId }));
        } catch {
          observation = { confidence: 'unavailable' as const, bot: 'unknown' as const };
        }
        if (guard && !guard.isCurrent()) return { status: 'stale' };
        const result = backend.apply(
          proof,
          observationOf(observation, chatId.split(':')[0]!),
          undefined,
          !!guard,
        );
        if (!guard || result.status !== 'stale') return result;
        const next = backend.retryOpening(proof);
        if (!next) return result;
        proof = next;
      }
    },
    owner,
    decide(proof: OwnerProof, decision: 'continue' | 'new') {
      return applyDecision(proof, decision);
    },
    deleteData(proof: OwnerProof, generation: number) {
      consumeOwner(proof);
      backend.ownerDelete(proof, generation);
      failedPauses.delete(proof.expected.chatId);
    },
  });
}
