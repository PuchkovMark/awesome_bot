import type { Database } from 'better-sqlite3';
import type {
  AddressForm,
  AddressPreferenceReference,
  ConnectionScope,
  UserId,
} from '../contracts/index';
import type { Storage } from './types';
import { personalDataStore } from './personal-data-store';
import { requireInput, timestamp } from './validation';

export type AddressPreferenceChange =
  | { readonly kind: 'set'; readonly form: string }
  | { readonly kind: 'reset' }
  | { readonly kind: 'visibility'; readonly value: 'chat' | 'bot' };

const preference = 'chat_id=? AND generation=? AND user_id=?';
interface StoredPreference {
  readonly form: string | null;
  readonly form_message_id: number | null;
  readonly visibility: 'chat' | 'bot' | 'unknown';
  readonly revision: number;
  readonly changed_message_id: number;
  readonly changed_at: number;
}

function read(db: Database, scope: ConnectionScope, user: UserId): StoredPreference | undefined {
  return db
    .prepare(`SELECT * FROM address_preferences WHERE ${preference}`)
    .get(scope.chatId, scope.generation, user) as StoredPreference | undefined;
}

export function createAddressPreferenceStore(privacy: ReturnType<typeof personalDataStore>) {
  function resolve(
    scope: ConnectionScope,
    userId: UserId,
    sourceTime: number,
    isGroupChat: boolean,
  ): AddressForm | undefined {
    if (!isGroupChat && scope.chatId !== userId) return undefined;
    return privacy.withProfileAdmission(scope, userId, sourceTime, (db) => {
      const saved = read(db, scope, userId);
      if (
        !saved?.form ||
        saved.visibility === 'unknown' ||
        (isGroupChat && saved.visibility !== 'chat')
      )
        return undefined;
      return {
        text: saved.form,
        reference: { userId, revision: saved.revision, sourceTime, isGroupChat },
      };
    });
  }
  return {
    resolve,
    current(scope: ConnectionScope, reference: AddressPreferenceReference): boolean {
      const { userId, sourceTime, isGroupChat, revision } = reference;
      return resolve(scope, userId, sourceTime, isGroupChat)?.reference.revision === revision;
    },
    change(
      scope: ConnectionScope,
      user: UserId,
      event: { readonly sequence: number; readonly at: number; readonly isGroupChat: boolean },
      change: AddressPreferenceChange,
      isCurrent: () => boolean,
    ) {
      const { sequence, at, isGroupChat } = event;
      timestamp(at);
      requireInput(Number.isSafeInteger(sequence) && sequence > 0);
      requireInput(isGroupChat || scope.chatId === user);
      if (change.kind === 'set')
        requireInput(!!change.form.trim() && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(change.form));
      return (
        privacy.withProfileAdmission(scope, user, at, (db) => {
          const settings = db
            .prepare('SELECT enabled,response_mode FROM chats WHERE chat_id=?')
            .get(scope.chatId) as { enabled: number; response_mode: string } | undefined;
          if (!isCurrent() || settings?.enabled !== 1 || settings.response_mode === 'silent')
            return 'blocked' as const;
          const old = read(db, scope, user);
          if (old && (old.changed_message_id >= sequence || old.changed_at > at))
            return 'stale' as const;
          const form =
            change.kind === 'reset'
              ? null
              : change.kind === 'set'
                ? change.form
                : (old?.form ?? null);
          const formSource =
            change.kind === 'set' ? sequence : form === null ? null : old!.form_message_id;
          const visibility =
            change.kind === 'visibility'
              ? change.value
              : (old?.visibility ?? (isGroupChat ? 'chat' : 'bot'));
          db.prepare(
            `INSERT INTO address_preferences VALUES(?,?,?,?,?,?,1,?,?)
          ON CONFLICT(chat_id,generation,user_id) DO UPDATE SET
          form=excluded.form,form_message_id=excluded.form_message_id,visibility=excluded.visibility,
          revision=revision+1,changed_message_id=excluded.changed_message_id,changed_at=excluded.changed_at`,
          ).run(scope.chatId, scope.generation, user, form, formSource, visibility, sequence, at);
          return 'changed' as const;
        }) ?? 'blocked'
      );
    },
  };
}

const stores = new WeakMap<Storage, ReturnType<typeof createAddressPreferenceStore>>();
export function registerAddressPreferences(
  storage: Storage,
  store: ReturnType<typeof createAddressPreferenceStore>,
) {
  stores.set(storage, store);
}
export function addressPreferenceStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
