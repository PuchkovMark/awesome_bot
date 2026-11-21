import {expect,test} from 'vitest';
import {contextConfig} from '../src/core/context/config.js';
import {estimateInput,staticMinimum} from '../src/core/context/budget.js';
import {validateContextStartup} from '../src/core/context/startup.js';
const c=contextConfig({modelContextTokens:16000});
test('конфигурация ограничивает общий ввод и резерв независимо от провайдера',()=>{
 expect(c.inputBudgetTokens).toBe(8000);expect(Object.isFrozen(c)).toBe(true);
 for(const patch of [{modelContextTokens:8000},{historyPageSize:257},{maxHistoryMessages:257},{preparationTimeoutMs:NaN},{environmentReserveTokens:8000}])expect(()=>contextConfig({...c,...patch})).toThrow('invalid_configuration');
});
test('оценка учитывает UTF-8 и сериализованные поля, а не длину русского текста',()=>{
 expect(estimateInput('Я',[{role:'user',text:'😀'}])).toBe(128+2+32+4);
 expect(estimateInput('',[{role:'user',text:JSON.stringify('"\n')}])).toBeGreaterThan(estimateInput('',[{role:'user',text:'"\n'}]));
});
test('нет fallback, начальная проверка различает отсутствие версии и размер статики',()=>{
 expect(validateContextStartup(null,c)).toBe('missing_system_prompt');
 const version={ref:{area:'global',kind:'system_prompt',key:'base',version:1},text:'x',createdAt:0} as const;
 const exact={...c,inputBudgetTokens:staticMinimum(version.text,c)};
 expect(validateContextStartup(version,exact)).toBe(null);
 expect(validateContextStartup(version,{...exact,inputBudgetTokens:exact.inputBudgetTokens-1})).toBe('static_budget_too_small');
});
