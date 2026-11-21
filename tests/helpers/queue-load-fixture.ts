import type { Database } from 'better-sqlite3';
import { participantFixture } from './participant-fixture.js';
export function seedLargeQueueChat(db:Database, generation:number, count:number) {
 const pf=participantFixture(db);
 db.transaction(()=>{
  const insert=db.prepare("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('vk:large',?,'vk:u','Имя','user','удаляемыйкот большой разговор',?)");
  for(let i=0;i<count;i++)insert.run(String(i),i);
  for(let i=0;i<2000;i++){const id=`vk:u${i}`;pf.participant('vk:large',id);pf.profile('vk:large',id);pf.fact('vk:large',id);}
  db.exec("INSERT INTO bot_admin_grants VALUES ('vk:large','vk:u','explicit',0,'vk:owner'); INSERT INTO bot_admin_revocations VALUES ('vk:large','vk:r','vk:owner',0); INSERT INTO bot_admin_revocation_audit VALUES ('vk:large','vk:r',1,0,0,'private');INSERT INTO bot_admin_controls VALUES ('vk:large',1)");
  db.prepare("INSERT INTO local_content_versions VALUES ('vk:large',?,'persona','test',1,'local',0)").run(generation);
  db.prepare("INSERT INTO chat_content_selections VALUES ('vk:large',?,'persona',NULL,NULL,'test',1)").run(generation);
  db.prepare("INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state) SELECT chat_id,?,id,0,9007199254740991,'queued' FROM messages WHERE chat_id='vk:large'").run(generation);
  db.prepare("INSERT INTO queue_turns VALUES ('vk:large',?,0)").run(generation);
 })();
}

export async function recordQueueLoad(result: Record<string,unknown>) {
 const {appendFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 appendFileSync(join(tmpdir(),'awesome-bot-queue-load-results.jsonl'),JSON.stringify({at:Date.now(),...result})+'\n');
}
