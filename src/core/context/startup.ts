import type {ContentVersion} from '../../contracts/versioning.js';
import type {ContextConfig} from './config.js';
import {staticMinimum} from './budget.js';
export function validateContextStartup(version:ContentVersion|null,c:ContextConfig):'missing_system_prompt'|'static_budget_too_small'|null {
 if(!version)return 'missing_system_prompt';
 return staticMinimum(version.text,c)>c.inputBudgetTokens?'static_budget_too_small':null;
}
