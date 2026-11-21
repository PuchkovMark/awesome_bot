import {expect,test} from 'vitest';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
test('ESM сборка экспортирует подготовку без сети и запуска обработчиков',async()=>{
 const file=pathToFileURL(resolve('dist/core/index.js')).href;
 const exports=await import(file) as Record<string,unknown>;
 expect(typeof exports.createContextPreparation).toBe('function');expect(typeof exports.createContextBuilder).toBe('function');
});
