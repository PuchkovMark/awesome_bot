import type {Storage} from '../storage/index.js';
import {createContextBuilder} from './context/index.js';
import type {ContextBuilderOptions} from './context/index.js';
/** Инфраструктурная композиция: полный Storage не передаётся сборщику. */
export function createContextPreparation(options:Omit<ContextBuilderOptions,'messages'|'state'>&{readonly storage:Storage}){
 return createContextBuilder({messages:options.storage.contextMessages,state:options.storage.contextState,config:options.config,capabilities:options.capabilities,sessionId:options.sessionId,...(options.now?{now:options.now}:{})});
}
