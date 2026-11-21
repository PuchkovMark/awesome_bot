import type { VersionLimits } from '../contracts/versioning.js';
import { object, requireInput, string } from './validation.js';
import { StorageError } from './errors.js';
export const defaultVersionLimits:VersionLimits=Object.freeze({textMaxLength:32000,maxPerEntity:100});
export function versionLimits(input:VersionLimits=defaultVersionLimits):VersionLimits {
 object(input,['textMaxLength','maxPerEntity']);const result={...input};
 for(const value of [result.textMaxLength,result.maxPerEntity])requireInput(Number.isSafeInteger(value)&&value>0);
 return Object.freeze(result);
}
export function versionText(text:unknown,limits:VersionLimits):asserts text is string {
 string(text);let length=0;for(const point of text){void point;if(++length>limits.textMaxLength)throw new StorageError('limit_exceeded');}
}
