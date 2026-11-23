import type { ChatId, Timestamp } from '../contracts/index';
import type { AuthorizationTransaction } from './authorization-types';
export type { AuthorizationTransaction, AdminGrant, RevocationAudit } from './authorization-types';

export interface AuthorizationStore {
  /** Promise из callback запрещён; исключение откатывает всю транзакцию. */
  transaction<T>(chatId: ChatId, callback: (transaction: AuthorizationTransaction) => T): Promise<T>;
  /** Внутреннее обслуживание, не интерфейс инструмента; не возвращает тексты. */
  pruneReasons(now: Timestamp, retentionMs: number): Promise<{ readonly cleared: number; readonly nextRevokedAt: number | null }>;
}
export interface SyncAuthorizationStore {
  transaction<T>(chatId:ChatId,callback:(transaction:AuthorizationTransaction)=>T):T;
  pruneReasons(now:Timestamp,retentionMs:number):{readonly cleared:number;readonly nextRevokedAt:number|null};
}
