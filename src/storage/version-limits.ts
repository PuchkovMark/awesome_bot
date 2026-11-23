import type { VersionLimits } from '../contracts/versioning';
import { object, requireInput, string } from './validation';
import { StorageError, safeError } from './errors';
export const defaultVersionLimits:VersionLimits=Object.freeze({textMaxLength:32000,maxPerEntity:100});
export function versionLimits(input:VersionLimits=defaultVersionLimits):VersionLimits {
 try{object(input,['textMaxLength','maxPerEntity']);const result={...input};
 for(const value of [result.textMaxLength,result.maxPerEntity])requireInput(Number.isSafeInteger(value)&&value>0);
 return Object.freeze(result);
 }catch(error){throw safeError(error,'invalid_input');}
}
export function versionText(text:unknown,limits:VersionLimits):asserts text is string {
 string(text);let length=0;for(const point of text){void point;if(++length>limits.textMaxLength)throw new StorageError('limit_exceeded');}
}
