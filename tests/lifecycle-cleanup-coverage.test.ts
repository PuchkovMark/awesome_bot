import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {migrate} from '../src/storage/migrate.js';
const tables=['notice_periods','queue_jobs','queue_turns','queue_lease','global_content_versions','local_content_versions','chat_content_selections','global_prompt_selection','bot_admin_controls','bot_admin_grants','bot_admin_revocation_audit','bot_admin_revocations','chat_connections','chat_participants','chats','lifecycle_clock','messages','messages_fts','messages_fts_config','messages_fts_data','messages_fts_docsize','messages_fts_idx','participant_profiles','profile_facts','schema_migrations','sqlite_sequence'];
const others=['context_messages','messages_queue_reference','queue_pending','chat_connections_scope','bot_admin_protected','messages_chat_time','profile_facts_participant','messages_ai','messages_ad','messages_au'];
function unknownObjects(db:Database.Database){return (db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex%'").all() as {name:string;type:string}[]).filter(o=>!(o.type==='table'?tables:others).includes(o.name));}
test('все таблицы, FTS, индексы и триггеры классифицированы; новая сущность требует расширить очистку',()=>{
 const db=new Database(':memory:');try{migrate(db);expect(unknownObjects(db)).toEqual([]);db.exec('CREATE TABLE new_chat_data(chat_id TEXT,value TEXT)');expect(unknownObjects(db)).toEqual([{name:'new_chat_data',type:'table'}]);}finally{db.close();}
});
