import { historyBounds } from './history-retention-store';
import type { Database } from 'better-sqlite3';
import type {
  AddressForm,
  AddressPreferenceReference,
  ConnectionScope,
  UserId,
} from '../contracts/index';
import type { Storage } from './types';
import { personalDataStore } from './personal-data-store';
import { participantProfileAvailable, readDeparture } from './participant-departures';
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
  const references = new WeakMap<
    AddressPreferenceReference,
    {
      readonly chatId: ConnectionScope['chatId'];
      readonly generation: number;
      readonly participation: number;
    }
  >();
  function resolve(
    scope: ConnectionScope,
    userId: UserId,
    sourceTime: number,
    isGroupChat: boolean,
    includeSource = false,
  ): (AddressForm & { readonly sourceId?: number }) | undefined {
    if (!isGroupChat && scope.chatId !== userId) return undefined;
    return privacy.withProfileAdmission(scope, userId, sourceTime, (db) => {
      const saved = read(db, scope, userId);
      if (
        !saved?.form ||
        saved.visibility === 'unknown' ||
        (isGroupChat && saved.visibility !== 'chat')
      )
        return undefined;
      const bounds = includeSource ? historyBounds(db, scope.chatId) : undefined;
      const sourceId =
        bounds && saved.form_message_id !== null
          ? (db
              .prepare(
                `SELECT id FROM personal_visible_messages WHERE chat_id=? AND platform_message_id=?
            AND id>? AND timestamp>?`,
              )
              .pluck()
              .get(
                scope.chatId,
                String(saved.form_message_id),
                bounds.clearedThrough,
                bounds.expiredThrough,
              ) as number | undefined)
          : undefined;
      const reference = Object.freeze({
        userId,
        revision: saved.revision,
        sourceTime,
        isGroupChat,
      });
      references.set(reference, {
        chatId: scope.chatId,
        generation: scope.generation,
        participation: readDeparture(db, scope, userId)?.revision ?? 0,
      });
      return {
        text: saved.form,
        ...(sourceId === undefined ? {} : { sourceId }),
        reference,
      };
    });
  }
  return {
    resolve(
      scope: ConnectionScope,
      userId: UserId,
      sourceTime: number,
      isGroupChat: boolean,
    ): AddressForm | undefined {
      return resolve(scope, userId, sourceTime, isGroupChat);
    },
    resolveForCard(
      scope: ConnectionScope,
      userId: UserId,
      sourceTime: number,
      isGroupChat: boolean,
    ) {
      return resolve(scope, userId, sourceTime, isGroupChat, true);
    },
    current(
      scope: ConnectionScope,
      reference: AddressPreferenceReference,
      card?: { readonly sourceId?: number },
    ): boolean {
      const saved = references.get(reference);
      if (saved?.chatId !== scope.chatId || saved.generation !== scope.generation) return false;
      const { userId, sourceTime, isGroupChat, revision } = reference;
      const latest = resolve(scope, userId, sourceTime, isGroupChat, !!card);
      return (
        latest?.reference.revision === revision &&
        references.get(latest.reference)?.participation === saved.participation &&
        (!card || latest.sourceId === card.sourceId)
      );
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
          if (!participantProfileAvailable(readDeparture(db, scope, user), at))
            return 'blocked' as const;
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
