import { expect,test } from 'vitest';
import { loadApplicationConfig } from '../src/config/application.js';

const env={VK_TOKEN:'test-vk',VK_GROUP_ID:'314',BOT_OWNER_ID:'vk:73',DATABASE_PATH:'test.sqlite',
 OPENCODE_API_KEY:'test-go',LLM_MODEL:'test',LLM_SESSION_SECRET:'test-session',MODEL_CONTEXT_TOKENS:'16000',MESSAGE_RETENTION_DAYS:'30'};

test('необязательные параметры F4.5 сохраняют запуск со старой конфигурацией',()=>{
 const load=(extra:Record<string,string>={})=>loadApplicationConfig({env:{...env,...extra},readFile:()=>''}).config.responseRate;
 expect(load()).toEqual({responsesPerMinute:6,floodThreshold:5,floodWindowMs:10000});
 expect(load({CHAT_RESPONSES_PER_MINUTE:'7',CHAT_MENTION_FLOOD_THRESHOLD:'4',CHAT_MENTION_FLOOD_WINDOW_MS:'9000'}))
   .toEqual({responsesPerMinute:7,floodThreshold:4,floodWindowMs:9000});
 for(const key of ['CHAT_RESPONSES_PER_MINUTE','CHAT_MENTION_FLOOD_THRESHOLD','CHAT_MENTION_FLOOD_WINDOW_MS']){
   expect(()=>load({[key]:'0'})).toThrow();
 }
});
