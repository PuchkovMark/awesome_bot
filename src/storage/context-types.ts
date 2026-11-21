import type {ConnectionScope} from '../contracts/lifecycle.js';
import type {StoredMessage,HistoryQuery} from './types.js';
/** Единственный reader, выдаваемый сборщику контекста и контекстному поиску. */
export interface ContextMessageReader {
 get(scope:ConnectionScope,id:number):Promise<StoredMessage|null>;
 list(scope:ConnectionScope,query:HistoryQuery):Promise<readonly StoredMessage[]>;
}
