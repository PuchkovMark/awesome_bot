import type {SafeLogger} from '../../logger/types.js';
export type TraceEvent='full_write_failed'|'size_exceeded'|'minimal_saved'|'trace_write_failed';
export function createTraceMetrics(logger?:SafeLogger){
 const counts={full_write_failed:0,size_exceeded:0,minimal_saved:0,trace_write_failed:0};
 return {record(event:TraceEvent){counts[event]=Math.min(Number.MAX_SAFE_INTEGER,counts[event]+1);try{logger?.event({event:'trace_stats',window:'run',...counts},'info');}catch{/* Диагностика не меняет выполнение. */}},snapshot:()=>Object.freeze({...counts})};
}
