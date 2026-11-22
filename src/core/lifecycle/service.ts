import { observationOf } from './source.js';
import type { ChatId, ConnectionScope, UserId, LifecycleSource } from '../../contracts/index.js';
import type { Storage } from '../../storage/index.js';
import { StorageError } from '../../storage/errors.js';
import { lifecycleBackend } from '../../storage/lifecycle-store.js';
import { validId } from '../authorization/validation.js';

export function createLifecycleService(options:{readonly storage:Storage;readonly ownerId:UserId;readonly source:LifecycleSource}) {
  if(!validId(options.ownerId))throw new TypeError('Lifecycle: invalid_owner');
  const ownerId=options.ownerId;
  const source=options.source;
  const backend=lifecycleBackend(options.storage);
  const owners = new WeakMap<object, symbol | undefined>();
  const failedPauses = new Map<ChatId, symbol>();
  return Object.freeze({
    /** Только доверенная входная граница приложения, не параметры модели. */
    current(chatId: ChatId) {return backend.current(chatId);},
    /** Область приёма действительна до следующей сверки или решения владельца. */
    admissionScope(chatId: ChatId) {
      if (failedPauses.has(chatId)) throw new StorageError('uncertain_connection');
      return backend.current(chatId,true);
    },
    activeChatIds(platform: string) {
      if(!/^[a-z][a-z0-9_-]*$/u.test(platform))throw new TypeError('Lifecycle: invalid_platform');
      return backend.activeChatIds(platform);
    },
    isAdmissionCurrent(scope: ConnectionScope) {
      try {
        if (failedPauses.has(scope.chatId)) return false;
        backend.revision(scope);
        return true;
      }
      catch {return false;}
    },
    /** Доверенный вход сообщает о возможном изменении подключения. */
    recordConnectionSignal(chatId: ChatId, key?: string) {
      if (!validId(chatId) || (key !== undefined && (typeof key !== 'string' || !key.trim()))) {
        throw new TypeError('Lifecycle: invalid_signal');
      }
      try {
        const result = backend.applyConnectionSignal(backend.begin(chatId), key);
        if (result.status === 'paused') failedPauses.delete(chatId);
        return result;
      } catch (error) {
        failedPauses.set(chatId, Symbol());
        throw error;
      }
    },
    async verify(chatId:ChatId, evidence?: 'observation_lost') {
      if(!validId(chatId))throw new TypeError('Lifecycle: invalid_chat');
      const proof=backend.begin(chatId);
      if(evidence==='observation_lost') {
        const result = backend.apply(proof,{confidence:'unavailable',bot:'unknown'});
        if (result.status === 'uncertain') failedPauses.delete(chatId);
        return result;
      }
      let observation;
      try {observation=await source.observe(Object.freeze({chatId}));}
      catch {observation={confidence:'unavailable' as const,bot:'unknown' as const};}
      return backend.apply(proof,observationOf(observation,chatId.split(':')[0]!));
    },
    /** Личность до вызова подтверждает приложение; функция не аутентифицирует VK. */
    owner(chatId:ChatId,userId:UserId) {
      if(!validId(chatId)||userId!==ownerId)throw new TypeError('Lifecycle: forbidden');
      const proof = backend.begin(chatId);
      owners.set(proof, failedPauses.get(chatId));
      return proof;
    },
    decide(proof:ReturnType<typeof backend.begin>,decision:'continue'|'new') {
      if(!proof || !owners.has(proof))throw new TypeError('Lifecycle: forbidden');
      const pauseAtDecisionStart = owners.get(proof);
      owners.delete(proof);
      if (pauseAtDecisionStart !== failedPauses.get(proof.expected.chatId)) throw new StorageError('stale_scope');
      const scope = backend.ownerDecision(proof,decision);
      failedPauses.delete(scope.chatId);
      return scope;
    },
  });
}
