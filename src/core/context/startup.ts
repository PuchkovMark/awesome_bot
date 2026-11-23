import type {ContentVersion} from '../../contracts/versioning';
import type {ContextConfig} from './config';
import {staticMinimum} from './budget';
export function validateContextStartup(version:ContentVersion|null,c:ContextConfig):'missing_system_prompt'|'static_budget_too_small'|null {
 if(!version)return 'missing_system_prompt';
 return staticMinimum(version.text,c)>c.inputBudgetTokens?'static_budget_too_small':null;
}
