import type { ChatId } from '../../src/contracts/index';
export const queueMessage=(chatId:ChatId,id:string)=>({chatId,messageId:id,userId:'vk:u' as const,authorName:'',text:id,role:'user' as const,timestamp:0});
export const flushQueue=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
