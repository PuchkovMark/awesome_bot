import type {StoredMessage} from '../../storage/context-types';
import type {AgentLoopMessage} from '../agent-loop/types';
export interface ContextEntry {readonly message:StoredMessage;readonly truncated?:boolean}

const dataMarker = { kind: 'untrusted_chat_data' } as const;
// Поле и запятая внутри существующего объекта, без внешних скобок.
export const dataMarkerBytes = Buffer.byteLength(JSON.stringify(dataMarker)) - 1;

function formatData(fields: object): string {
 return JSON.stringify({...dataMarker,...fields});
}

export function messageData(entry:ContextEntry,timezone:string){
 const m=entry.message;
 return {author:m.authorName,time:new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,dateStyle:'short',timeStyle:'medium'}).format(m.timestamp),bot:m.role==='assistant',text:m.text||(m.attachmentCount===1?'[Вложение: содержимое недоступно.]':'[Текст сообщения отсутствует; содержимое недоступно.]'),...(entry.truncated?{truncated:true}: {})};
}
export function formatMessages(history:readonly ContextEntry[],current:StoredMessage,reply:ContextEntry|null,replyState:string,group:boolean,timezone:string):readonly AgentLoopMessage[] {
 const quote=reply?messageData(reply,timezone):replyState==='unavailable'?{unavailable:true}:null;
 const latest = {reply:quote,current:messageData({message:current},timezone)};
 if(group)return [{role:'user',text:formatData({history:history.map(m=>messageData(m,timezone)),...latest})}];
 return [
  ...history.map(entry=>({role:entry.message.role,text:formatData({history:messageData(entry,timezone)})})),
  {role:'user',text:formatData(latest)},
 ];
}
