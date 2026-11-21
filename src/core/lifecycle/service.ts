import type { ChatId, UserId, LifecycleSource } from '../../contracts/index.js';
import type { Storage } from '../../storage/index.js';
import { lifecycleBackend } from '../../storage/lifecycle-store.js';
import { validId } from '../authorization/validation.js';

export function createLifecycleService(options:{readonly storage:Storage;readonly ownerId:UserId;readonly source:LifecycleSource}) {
  if(!validId(options.ownerId))throw new TypeError('Lifecycle: invalid_owner');
  const backend=lifecycleBackend(options.storage);
  const owners=new WeakSet<object>();
  return Object.freeze({
    /** Только доверенная входная граница приложения, не параметры модели. */
    current:backend.current,
    async verify(chatId:ChatId) {
      if(!validId(chatId))throw new TypeError('Lifecycle: invalid_chat');
      const proof=backend.begin(chatId);
      let observation;
      try {observation=await options.source.observe(Object.freeze({chatId}));}
      catch {observation={confidence:'unavailable' as const,bot:'unknown' as const};}
      return backend.apply(proof,observation);
    },
    /** Личность до вызова подтверждает приложение; функция не аутентифицирует VK. */
    owner(chatId:ChatId,userId:UserId) {
      if(!validId(chatId)||userId!==options.ownerId)throw new TypeError('Lifecycle: forbidden');
      const proof=backend.begin(chatId);owners.add(proof);return proof;
    },
    decide(proof:ReturnType<typeof backend.begin>,decision:'continue'|'new') {
      if(!proof || !owners.has(proof))throw new TypeError('Lifecycle: forbidden');
      owners.delete(proof);return backend.ownerDecision(proof,decision);
    },
  });
}
