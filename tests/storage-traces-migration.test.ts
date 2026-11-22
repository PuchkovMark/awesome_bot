import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {migrate} from '../src/storage/migrate.js';
import {migrations} from '../src/storage/migrations/index.js';
test('11→12 сохраняет историю миграций; повтор и откат новой схемы',()=>{
 const db=new Database(':memory:');try{
 db.pragma('foreign_keys=ON');migrate(db,migrations.slice(0,11));const old=db.prepare('SELECT * FROM schema_migrations').all();const saved=db.serialize();
 expect(()=>migrate(db,[...migrations,{version:migrations.length+1,name:'bad',sql:'INVALID SQL;'}])).toThrow('migration_failed');expect(db.serialize()).toEqual(saved);
 migrate(db);expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=11').all()).toEqual(old);expect(db.pragma('foreign_key_check')).toEqual([]);const after=db.serialize();migrate(db);expect(db.serialize()).toEqual(after);
 expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='response_traces'").get()).toEqual({name:'response_traces'});
 }finally{db.close();}
});
