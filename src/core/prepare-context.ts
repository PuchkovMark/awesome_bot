import type {SafeLogger} from '../logger/types.js';
import type {Storage} from '../storage/index.js';
import {createContextBuilder} from './context/index.js';
import type {ContextBuilderOptions} from './context/index.js';
/** Инфраструктурная композиция: полный Storage не передаётся сборщику. */
export function createContextPreparation(options:Omit<ContextBuilderOptions,'messages'|'state'>&{readonly storage:Storage;readonly logger?:SafeLogger}){
 return createContextBuilder({messages:options.storage.contextMessages,state:options.storage.contextState,config:options.config,capabilities:options.capabilities,sessionId:options.sessionId,onStats:stats=>{options.logger?.event({event:'context_stats',window:'run',...stats},'info');options.onStats?.(stats);},...(options.now?{now:options.now}:{})});
}
