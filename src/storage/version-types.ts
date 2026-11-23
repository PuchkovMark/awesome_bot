import type { ConnectionScope } from '../contracts/lifecycle';
import type { AppendVersionResult, ContentVersion, GlobalVersionRef, LocalContentKind, SelectionResult, VersionInput, VersionRef } from '../contracts/versioning';
export interface VersionStore {
 append(scope:ConnectionScope,input:VersionInput<LocalContentKind>):Promise<AppendVersionResult>;
 get(scope:ConnectionScope,ref:VersionRef):Promise<ContentVersion|null>;
 systemPrompt(scope:ConnectionScope):Promise<ContentVersion|null>;
 selected(scope:ConnectionScope,kind:LocalContentKind):Promise<ContentVersion|null>;
 select(scope:ConnectionScope,kind:LocalContentKind,ref:VersionRef,expected:VersionRef|null):Promise<SelectionResult>;
 reset(scope:ConnectionScope,kind:LocalContentKind,expected:VersionRef|null):Promise<SelectionResult>;
}
export interface CatalogAdministration {
 append(input:VersionInput):Promise<AppendVersionResult>;
 get(ref:GlobalVersionRef):Promise<ContentVersion|null>;
 systemPrompt():Promise<ContentVersion|null>;
 selectSystemPrompt(ref:GlobalVersionRef,expected:GlobalVersionRef|null):Promise<SelectionResult>;
 resetSystemPrompt(expected:GlobalVersionRef|null):Promise<SelectionResult>;
}
