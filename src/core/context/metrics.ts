import type {PreparationFailure,PreparationResult} from './types.js';
export function createContextMetrics(){
 const counts={missing_system_prompt:0,static_budget_too_small:0,current_message_too_large:0,internal_error:0,cancelled:0,unavailable:0,deadline_exceeded:0};
 return Object.freeze({
  record(value:PreparationResult|PreparationFailure){const key=typeof value==='string'?value:value.kind==='failed'?value.reason:value.kind==='ready'?null:value.kind;if(key)counts[key]=Math.min(Number.MAX_SAFE_INTEGER,counts[key]+1);},
  snapshot(){return Object.freeze({...counts});},
 });
}
