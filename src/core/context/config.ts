export interface ContextConfig {
 readonly modelContextTokens:number;readonly inputBudgetTokens:number;readonly maxOutputTokens:number;
 readonly environmentReserveTokens:number;readonly historyPageSize:number;readonly maxHistoryMessages:number;
 readonly maxScannedMessages:number;readonly historyTextCodePoints:number;readonly replyTextCodePoints:number;
 readonly preparationTimeoutMs:number;readonly postPreparationMarginMs:number;
}
export function contextConfig(input:Pick<ContextConfig,'modelContextTokens'>&Partial<ContextConfig>):ContextConfig {
 const defaults={inputBudgetTokens:8000,maxOutputTokens:1024,environmentReserveTokens:1024,historyPageSize:32,maxHistoryMessages:128,maxScannedMessages:256,historyTextCodePoints:2048,replyTextCodePoints:1024,preparationTimeoutMs:2000,postPreparationMarginMs:1000};
 if(!input||Object.keys(input).some(k=>k!=='modelContextTokens'&&!Object.hasOwn(defaults,k)))throw new TypeError('Context: invalid_configuration');
 const c={...defaults,...input};
 if(Object.values(c).some(v=>!Number.isSafeInteger(v)||v<=0||v>2147483647)||c.inputBudgetTokens+c.maxOutputTokens>c.modelContextTokens||c.historyPageSize>256||c.maxScannedMessages>4096||c.historyTextCodePoints>16384||c.replyTextCodePoints>16384||c.historyPageSize>c.maxScannedMessages||c.maxHistoryMessages>c.maxScannedMessages||c.environmentReserveTokens>=c.inputBudgetTokens)throw new TypeError('Context: invalid_configuration');
 return Object.freeze(c);
}
