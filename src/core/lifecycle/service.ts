import { observationOf } from './source.js';
import type { ChatId, ConnectionScope, UserId, LifecycleSource } from '../../contracts/index.js';
import type { Storage } from '../../storage/index.js';
import { lifecycleBackend } from '../../storage/lifecycle-store.js';
import { validId } from '../authorization/validation.js';

export function createLifecycleService(options:{readonly storage:Storage;readonly ownerId:UserId;readonly source:LifecycleSource}) {
  if(!validId(options.ownerId))throw new TypeError('Lifecycle: invalid_owner');
  const ownerId=options.ownerId;
  const source=options.source;
  const backend=lifecycleBackend(options.storage);
  const owners=new WeakSet<object>();
  return Object.freeze({
    /** Только доверенная входная граница приложения, не параметры модели. */
    current(chatId: ChatId) {return backend.current(chatId);},
    /** Область приёма действительна до следующей сверки или решения владельца. */
    admissionScope(chatId: ChatId) {return backend.current(chatId,true);},
    activeChatIds(platform: string) {
      if(!/^[a-z][a-z0-9_-]*$/u.test(platform))throw new TypeError('Lifecycle: invalid_platform');
      return backend.activeChatIds(platform);
    },
    isAdmissionCurrent(scope: ConnectionScope) {
      try {backend.revision(scope);return true;}
      catch {return false;}
    },
    async verify(chatId:ChatId, evidence?: 'observation_lost') {
      if(!validId(chatId))throw new TypeError('Lifecycle: invalid_chat');
      const proof=backend.begin(chatId);
      if(evidence==='observation_lost')return backend.apply(proof,{confidence:'unavailable',bot:'unknown'});
      let observation;
      try {observation=await source.observe(Object.freeze({chatId}));}
      catch {observation={confidence:'unavailable' as const,bot:'unknown' as const};}
      return backend.apply(proof,observationOf(observation,chatId.split(':')[0]!));
    },
    /** Личность до вызова подтверждает приложение; функция не аутентифицирует VK. */
    owner(chatId:ChatId,userId:UserId) {
      if(!validId(chatId)||userId!==ownerId)throw new TypeError('Lifecycle: forbidden');
      const proof=backend.begin(chatId);owners.add(proof);return proof;
    },
    decide(proof:ReturnType<typeof backend.begin>,decision:'continue'|'new') {
      if(!proof || !owners.has(proof))throw new TypeError('Lifecycle: forbidden');
      owners.delete(proof);return backend.ownerDecision(proof,decision);
    },
  });
}
