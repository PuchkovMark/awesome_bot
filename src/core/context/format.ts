import type {StoredMessage} from '../../storage/context-types.js';
import type {AgentLoopMessage} from '../agent-loop/types.js';
export interface ContextEntry {readonly message:StoredMessage;readonly truncated?:boolean}
export function messageData(entry:ContextEntry,timezone:string){
 const m=entry.message;
 return {author:m.authorName,time:new Intl.DateTimeFormat('ru-RU',{timeZone:timezone,dateStyle:'short',timeStyle:'medium'}).format(m.timestamp),bot:m.role==='assistant',text:m.text||(m.attachmentCount===1?'[Вложение: содержимое недоступно.]':'[Текст сообщения отсутствует; содержимое недоступно.]'),...(entry.truncated?{truncated:true}: {})};
}
export function formatMessages(history:readonly ContextEntry[],current:StoredMessage,reply:ContextEntry|null,replyState:string,group:boolean,timezone:string):readonly AgentLoopMessage[] {
 const quote=reply?messageData(reply,timezone):replyState==='unavailable'?{unavailable:true}:null;
 if(group)return [{role:'user',text:JSON.stringify({history:history.map(m=>messageData(m,timezone)),reply:quote,current:messageData({message:current},timezone)})}];
 return [...history.map(e=>({role:e.message.role,text:JSON.stringify(messageData(e,timezone))})),{role:'user' as const,text:JSON.stringify({reply:quote,current:messageData({message:current},timezone)})}];
}
