import Database from 'better-sqlite3';
import { reconcileStagedPersonalData } from '../src/storage/personal-data-restore';
import { expect, test } from 'vitest';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { personalDataStore } from '../src/storage/personal-data-store';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { storageFixture } from './helpers/storage-fixture';
import { participantFixture } from './helpers/participant-fixture';
import {
  noteParticipantMessage,
  participantRegistryStore,
} from '../src/storage/participant-registry';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { lifecycleBackend } from '../src/storage/lifecycle-store';

test('допуск к профилю зависит от подтверждённой версии, области и отказа', async () => {
  const f = storageFixture();
  let storage = await openStorage(f.path);
  try {
    const scope = scopeFor(storage, 'vk:first'),
      other = scopeFor(storage, 'vk:other');
    const notices = disclosureStore(storage),
      privacy = personalDataStore(storage);
    const input = {
      provider: 'test',
      dataPolicy: 'local',
      storagePolicy: 'journal',
      detailsText: 'test',
      detailsUrl: 'https://example.test/',
      ownerContact: 'test',
      change: 'material' as const,
    };
    function deliver(version: number, kind: 'introduction' | 'update', at: number) {
      const row = notices.ensure(scope, kind, version);
      const claim = notices.claim(scope, row.id, 'текст', at)!;
      expect(notices.finish(scope, claim, 'delivered', at, null, String(at))).toBe(true);
    }
    deliver(notices.register(input, 1), 'introduction', 2);
    expect(privacy.profileAllowed(scope, 'vk:1', 3)).toBe(false);
    const v = notices.register({ ...input, profileNotice: 'Синтетическое уведомление' }, 4);
    expect(privacy.profileAllowed(scope, 'vk:1', 5)).toBe(false);
    deliver(v, 'update', 6);
    expect(privacy.profileAllowed(scope, 'vk:1', 6)).toBe(false);
    expect(privacy.profileAllowed(other, 'vk:1', 7)).toBe(false);
    privacy.withProfileAdmission(scope, 'vk:1', 7, (db) => {
      const seed = participantFixture(db);
      seed.chat(scope.chatId);
      seed.participant(scope.chatId, 'vk:1');
      seed.profile(scope.chatId, 'vk:1');
      seed.fact(scope.chatId, 'vk:1');
    });
    const until = privacy.disable(scope, 'vk:1', 10);
    expect(privacy.disable(scope, 'vk:1', 15)).toBe(until);
    expect(privacy.withProfileAdmission(scope, 'vk:1', 7, () => true)).toBeUndefined();
    expect(privacy.profileAllowed(scope, 'vk:2', 7)).toBe(true);
    await storage.close();
    storage = await openStorage(f.path);
    const fresh = personalDataStore(storage);
    expect(fresh.purgeExpired(until - 1)).toBe(0);
    expect(fresh.purgeExpired(until)).toBe(1);
    expect(fresh.purgeExpired(until)).toBe(0);
    expect(fresh.profileAllowed(scopeFor(storage, 'vk:first'), 'vk:1', until)).toBe(false);
  } finally {
    await storage.close();
    f.cleanup();
  }
});

test('удаление скрывает источники сразу, сохраняет независимый ответ и защищённое назначение', async () => {
  const f = storageFixture();
  let storage = await openStorage(f.path);
  const at = Date.now(),
    chat = 'vk:2000000010',
    user = 'vk:10';
  try {
    const scope = scopeFor(storage, chat),
      other = scopeFor(storage, 'vk:2000000011');
    for (const area of [scope, other]) {
      await storage.chats.create(area, { createdAt: 0, enabled: true, responseMode: 'normal' });
      await storage.messages.append(area, {
        chatId: area.chatId,
        userId: user,
        messageId: '10',
        text: 'закрытый факт',
        authorName: 'Имя',
        role: 'user',
        timestamp: at,
      });
    }
    const saved = await storage.messages.append(scope, {
      chatId: chat,
      userId: 'vk:11',
      messageId: '11',
      text: 'независимый ответ',
      replyToMessageId: '10',
      role: 'user',
      authorName: 'Другой',
      timestamp: at,
    });
    await storage.authorization.transaction(scope, (tx) =>
      tx.grant({ userId: user, basis: 'creator', grantedAt: at, grantedBy: null }),
    );
    const privacy = personalDataStore(storage);
    expect(privacy.export(scope, user, at).messages).toHaveLength(1);
    const backup = new Database(f.path);
    try {
      await backup.backup(f.path + '.staged');
    } finally {
      backup.close();
    }
    const expired = privacy.requestDeletion(scope, user, 'a', at);
    expect(privacy.confirmDeletion(scope, user, expired.code, at + 900000)).toBe(false);
    const request = privacy.requestDeletion(scope, user, 'b', at);
    expect(privacy.confirmDeletion(other, user, request.code, at)).toBe(false);
    expect(privacy.confirmDeletion(scope, 'vk:11', request.code, at)).toBe(false);
    expect(privacy.confirmDeletion(scope, user, request.code, at + 899999)).toBe(true);
    expect(privacy.confirmDeletion(scope, user, request.code, at + 899999)).toBe(false);
    expect(await storage.contextMessages.search(scope, 'закрытый', 5, 128)).toEqual([]);
    expect(await storage.messages.get(scope, saved.id)).not.toHaveProperty('replyToMessageId');
    expect(() => privacy.export(scope, user, at + 900000)).toThrow();
    expect(privacy.status(scope, user, at + 900000)).toContain('защищённых прав');
    await storage.close();
    storage = await openStorage(f.path);
    const reopened = personalDataStore(storage);
    expect(reopened.cleanup(at + 900000)).toBe(1);
    expect(await storage.messages.list(scopeFor(storage, chat), { limit: 10 })).toMatchObject([
      { text: 'независимый ответ' },
    ]);
    const staged = new Database(f.path + '.staged'),
      newer = new Database(f.path, { readonly: true });
    try {
      expect(
        staged
          .prepare(
            'SELECT count(*) AS n FROM personal_visible_messages WHERE chat_id=? AND user_id=?',
          )
          .get(chat, user),
      ).toEqual({ n: 1 });
      reconcileStagedPersonalData(staged, newer, at + 900000);
      expect(
        staged
          .prepare(
            'SELECT count(*) AS n FROM personal_visible_messages WHERE chat_id=? AND user_id=?',
          )
          .get(chat, user),
      ).toEqual({ n: 0 });
      expect(
        staged
          .prepare(
            'SELECT count(*) AS n FROM personal_visible_messages WHERE chat_id=? AND user_id=?',
          )
          .get(other.chatId, user),
      ).toEqual({ n: 1 });
    } finally {
      staged.close();
      newer.close();
    }
    const current = scopeFor(storage, chat);
    expect(reopened.status(current, user, at + 900000)).toContain('проверена');
    expect(reopened.reportMessage(current, user, '11')).toBe(true);
    expect(reopened.disputed(current)).toEqual([{ messageId: '11' }]);
    expect(reopened.status(current, user, at + 899999 + 86400000)).toContain('Истёк срок');
    expect(await storage.messages.list(current, { limit: 10 })).toEqual([]);
    expect(reopened.resolveDisputed(current, '11', 'keep')).toBe(true);
    reopened.cleanup(at + 899999 + 86400000);
    expect(reopened.status(current, user, at + 899999 + 86400000)).toContain('проверена');
    expect(
      await storage.contextMessages.search(scopeFor(storage, other.chatId), 'закрытый', 5, 128),
    ).toHaveLength(1);
  } finally {
    await storage.close();
    f.cleanup();
  }
});

test('удаление аудита оставляет действующий запрет; владелец может снять его после перезапуска', async () => {
  const f = storageFixture();
  let s = await openStorage(f.path);
  const chat = 'vk:2000000071',
    user = 'vk:126';
  try {
    const scope = scopeFor(s, chat);
    await s.chats.create(scope, { createdAt: 0, enabled: true, responseMode: 'normal' });
    await s.messages.append(scope, {
      chatId: chat,
      userId: user,
      messageId: 'a',
      authorName: 'X',
      text: 'факт',
      role: 'user',
      timestamp: 1,
    });
    await s.authorization.transaction(scope, (tx) =>
      tx.revoke({
        userId: user,
        revokedBy: 'vk:1',
        revokedAt: 1,
        bases: ['inviter'],
        reason: 'закрытая причина',
      }),
    );
    const privacy = personalDataStore(s),
      req = privacy.requestDeletion(scope, user, 'request', 2);
    expect(privacy.confirmDeletion(scope, user, req.code, 3)).toBe(true);
    expect(privacy.status(scope, user, 3)).toContain('запрет');
    await s.close();
    s = await openStorage(f.path);
    await s.authorization.transaction(scopeFor(s, chat), (tx) => {
      expect(tx.isRevoked(user)).toBe(true);
      expect(tx.audit(user)).toBeNull();
      tx.restore(user);
      expect(tx.isRevoked(user)).toBe(false);
    });
  } finally {
    await s.close();
    f.cleanup();
  }
});

test('перечень источников F5.8 охватывает таблицы действующей схемы', async () => {
  const db = new Database(':memory:');
  try {
    const { migrate } = await import('../src/storage/migrate');
    migrate(db);
    const categories = {
      personal:
        'chat_participants participant_profiles profile_facts chat_author_labels messages request_quota_admissions chat_control_commands history_clear_requests personal_profile_choices personal_exports address_preferences',
      dependent:
        'messages_fts messages_fts_config messages_fts_data messages_fts_docsize messages_fts_idx personal_answer_sources queue_jobs response_traces mention_flood_inputs autonomous_questions autonomous_reply_parts',
      authority:
        'admin_presence admin_observations admin_recovery_operations bot_admin_grants bot_admin_revocations bot_admin_revocation_audit personal_retained_denials',
      privateReminders:
        'personal_reminders personal_reminder_parts personal_reminder_inputs personal_reminder_timezones',
      erasureAndReplay:
        'personal_deletions personal_hidden_messages history_deleted_inputs participant_events',
      sharedSettingsAndUsage:
        'chats chat_connections lifecycle_clock chat_token_budgets token_budget_attempts response_rate_clock response_rate_publications mention_flood_state history_retention_policy history_retention_boundaries autonomous_quota_reservations chat_controls disclosure_versions disclosure_publications connection_membership_signals notice_periods queue_turns queue_lease global_content_versions local_content_versions chat_content_selections global_prompt_selection bot_admin_controls participant_sync schema_migrations sqlite_sequence',
    };
    const actual = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .pluck()
      .all();
    expect(
      Object.values(categories)
        .flatMap((names) => names.split(' '))
        .sort(),
    ).toEqual(actual);
  } finally {
    db.close();
  }
});

test('сверка, событие и отметка сообщения сохраняют подтверждённое удаление из реестра', async () => {
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, 'vk:2000000411');
    const neighbor = scopeFor(storage, 'vk:2000000412');
    const user = 'vk:15';
    const registry = participantRegistryStore(storage);
    const budget = tokenBudgetStore(storage);
    const privacy = personalDataStore(storage);
    const membership = {
      complete: true,
      people: 2,
      members: [
        { userId: user, role: 'admin' },
        { userId: 'vk:16', role: 'unknown' },
      ],
    } as const;
    for (const group of [scope, neighbor])
      expect(
        budget.finishObservation(group, budget.beginObservation(group, 1), membership, 2),
      ).toBe(true);
    const request = privacy.requestDeletion(scope, user, 'one', 3);
    expect(privacy.confirmDeletion(scope, user, request.code, 4)).toBe(true);
    expect(
      registry.observe(scope, {
        kind: 'membership',
        change: 'joined',
        chatId: scope.chatId,
        subjectId: user,
        actorId: user,
        eventId: 'event',
        timestamp: 5,
      }),
    ).toBe(true);
    lifecycleBackend(storage).transaction(scope, (db) =>
      noteParticipantMessage(db, scope, user, 6),
    );
    expect(registry.read(scope).participants.map((row) => row.userId)).toEqual(['vk:16']);
    expect(budget.finishObservation(scope, budget.beginObservation(scope, 7), membership, 8)).toBe(
      true,
    );
    expect(registry.read(scope).participants.map((row) => row.userId)).toEqual(['vk:16']);
    expect(budget.read(scope, true, 8).people).toBe(2);
    expect(registry.read(neighbor).participants.map((row) => row.userId)).toEqual([user, 'vk:16']);
  } finally {
    await storage.close();
  }
});
