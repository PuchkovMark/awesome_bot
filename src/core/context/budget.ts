import type {AgentLoopMessage} from '../agent-loop/types';
import type {ContextConfig} from './config';
import {dataMarkerBytes} from './format';
export const contextSeparator='\n\nОкружение харнеса:\n';
export function estimateInput(system:string,messages:readonly AgentLoopMessage[]):number {
 return 128+Buffer.byteLength(system,'utf8')+messages.reduce((n,m)=>n+32+Buffer.byteLength(m.text,'utf8'),0);
}
export function staticMinimum(text:string,c:ContextConfig):number {
 return estimateInput(text+contextSeparator,[{role:'user',text:''}])+c.environmentReserveTokens+256+dataMarkerBytes;
}
