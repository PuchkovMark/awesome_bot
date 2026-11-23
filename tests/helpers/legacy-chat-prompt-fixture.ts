import type Database from 'better-sqlite3';
import {migrate} from '../../src/storage/migrate';
import {migrations} from '../../src/storage/migrations/index';
import {participantFixture} from './participant-fixture';
export const legacyPrompt='LEGACY_PRIVATE_PROMPT_016';
export const sharedPrompt='Общие правила без индивидуальных настроек.';
export function legacyChatPromptFixture(db:Database.Database,selected=true){
 db.pragma('foreign_keys=ON');migrate(db,migrations.slice(0,10));
 db.prepare("INSERT INTO chats(chat_id,title,system_prompt,response_mode,timezone,enabled,created_at) VALUES('vk:old','Сохранить название',?,'normal','UTC',1,10),('vk:other','Другая беседа',?,'silent','Europe/Moscow',0,20)").run(legacyPrompt,'другой старый текст');
 db.exec("INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:old',1,0,'active'),('vk:other',2,0,'active'); UPDATE lifecycle_clock SET value=2;");
 const insert=db.prepare("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp,attachment_count) VALUES('vk:old',?,'vk:u','Имя','user',?,0,0)");
 insert.run('trigger','Пенек помоги кот');insert.run('running','ещё сообщение');insert.run('terminal','третье сообщение');
 const now=Date.now();const job=db.prepare("INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,outcome,owner,route_kind,route_mode,route_group) VALUES('vk:old',1,?,?,?,?,?,?,'name','normal',1)");
 job.run(1,now,now+600000,'queued',null,null);job.run(2,now,now+600000,'running',null,'previous-owner');job.run(3,now,now+600000,'terminal','completed',null);
 db.prepare("INSERT INTO global_content_versions VALUES('system_prompt','base',1,?,0)").run(sharedPrompt);
 db.exec("INSERT INTO global_content_versions VALUES('persona','base',1,'общий персонаж',0); INSERT INTO local_content_versions VALUES('vk:old',1,'persona','local',1,'локальный персонаж',0),('vk:old',1,'greeting_template','greet',1,'приветствие',0); INSERT INTO chat_content_selections VALUES('vk:old',1,'persona',NULL,NULL,'local',1),('vk:old',1,'greeting_template',NULL,NULL,'greet',1);");
 if(selected)db.exec("INSERT INTO global_prompt_selection VALUES('system_prompt','base',1)");
 const pf=participantFixture(db);pf.participant('vk:old','vk:u');pf.profile('vk:old','vk:u');pf.fact('vk:old','vk:u');
 db.exec("INSERT INTO bot_admin_grants VALUES('vk:old','vk:u','explicit',0,'vk:owner');");
}
