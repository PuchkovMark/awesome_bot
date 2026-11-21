import type {SafeLogger} from '../../logger/types.js';
import type {RoutingDecision} from './types.js';
export function createRouterMetrics(logger?:SafeLogger){
 let unknown=0;
 return Object.freeze({
  record(decision:RoutingDecision){
   if(decision.reason!=='sender_unknown')return;
   unknown=Math.min(Number.MAX_SAFE_INTEGER,unknown+1);
   try{logger?.event({event:'router_stats',window:'run',senderUnknown:unknown},'info');}catch{/* Логгер не меняет решение. */}
  },
  snapshot(){return Object.freeze({senderUnknown:unknown});},
 });
}
