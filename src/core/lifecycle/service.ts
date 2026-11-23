import { observationOf } from './source';
import type {
  ChatId,
  ConnectionScope,
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
      if (!/^[a-z][a-z0-9_-]*$/u.test(platform)) throw new TypeError('Lifecycle: invalid_platform');
      return backend.activeChatIds(platform);
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
    async verify(chatId: ChatId, evidence?: 'observation_lost' | 'startup' | 'first_seen') {
      if (!validId(chatId)) throw new TypeError('Lifecycle: invalid_chat');
      const proof = backend.begin(chatId);
      if (evidence !== undefined) {
        const result = backend.apply(
          proof,
          { confidence: 'unavailable', bot: 'unknown' },
          evidence,
        );
        if (result.status === 'uncertain') failedPauses.delete(chatId);
        return result;
      }
      let observation;
      try {
        observation = await source.observe(Object.freeze({ chatId }));
      } catch {
        observation = { confidence: 'unavailable' as const, bot: 'unknown' as const };
      }
      return backend.apply(proof, observationOf(observation, chatId.split(':')[0]!));
    },
    /** Личность до вызова подтверждает приложение; функция не аутентифицирует VK. */
    owner(chatId: ChatId, userId: UserId) {
      if (!validId(chatId) || userId !== ownerId) throw new TypeError('Lifecycle: forbidden');
      const proof = backend.begin(chatId);
      owners.set(proof, failedPauses.get(chatId));
      return proof;
    },
    decide(proof: ReturnType<typeof backend.begin>, decision: 'continue' | 'new') {
      if (!proof || !owners.has(proof)) throw new TypeError('Lifecycle: forbidden');
      const pauseAtDecisionStart = owners.get(proof);
      owners.delete(proof);
      if (pauseAtDecisionStart !== failedPauses.get(proof.expected.chatId))
        throw new StorageError('stale_scope');
      const scope = backend.ownerDecision(proof, decision);
      failedPauses.delete(scope.chatId);
      return scope;
    },
    deleteData(proof: ReturnType<typeof backend.begin>, generation: number) {
      if (!proof || !owners.has(proof)) throw new TypeError('Lifecycle: forbidden');
      const pauseAtDecisionStart = owners.get(proof);
      owners.delete(proof);
      if (pauseAtDecisionStart !== failedPauses.get(proof.expected.chatId))
        throw new StorageError('stale_scope');
      backend.ownerDelete(proof, generation);
      failedPauses.delete(proof.expected.chatId);
    },
  });
}
