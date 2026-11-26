import { join } from 'node:path';
import { expect, test } from 'vitest';
import { storageFixture } from './helpers/storage-fixture';
import { scopeFor } from './helpers/connection-scope';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { createSnapshot, openExisting, openCandidate } from '../src/storage/database-backup';
import { reconcileConnections } from '../src/storage/database-restore';
import { profileFixture, alice, set } from './helpers/profile-fact-fixture';
import { reconcileStagedPersonalData } from '../src/storage/personal-data-restore';
import { reconcileRestore } from '../src/storage/backup-history';
import { personalDataStore } from '../src/storage/personal-data-store';
import { createAuthorizationService } from '../src/core/index';
import { chatControlStore } from '../src/storage/chat-control-store';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import Database from 'better-sqlite3';

test.each([58, 59])(
  'старый снимок напоминания сверяется с рабочей схемой %s по именам полей',
  async (version) => {
    const files = storageFixture();
    const snapshot = join(files.directory, 'reminders.sqlite');
    const candidate = join(files.directory, 'reminders-candidate.sqlite');
    const now = Date.parse('2026-11-26T12:00:00Z');
    const dueAt = now + 60_000;
    const live = new Database(files.path);
    try {
      live.pragma('foreign_keys=ON');
      migrate(live, migrations.slice(0, 58));
      live.exec(
        "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('vk:41',1,0,'active')",
      );
      live
        .prepare(
          `INSERT INTO personal_reminders(id,chat_id,generation,origin_at,text,due_at,timezone,next_at,state,confirmation)
       VALUES (12,'vk:41',1,?,'взять билет',?,'UTC',?,'pending','unknown')`,
        )
        .run(now, dueAt, dueAt);
      live
        .prepare(
          `INSERT INTO personal_reminder_parts(reminder_id,stage,part,send_id,text,state,attempted_at,receipt)
       VALUES (12,'confirmation',0,8,'Первая','confirmed',?,'80'),
              (12,'confirmation',1,9,'Вторая','unknown',?,'81')`,
        )
        .run(now, now);
      const before = openExisting(files.path);
      try {
        await createSnapshot(before, snapshot, 'one', now);
      } finally {
        before.close();
      }
      if (version === 59) {
        migrate(live);
        live.exec(`UPDATE personal_reminders SET schedule_key='relative:1',hint_claimed=1;
        UPDATE personal_reminder_parts SET state='ready',receipt=NULL,definite_failure=1 WHERE part=1;`);
      }
      await openCandidate(snapshot, candidate, 'one', now + 1);
      const restored = openExisting(candidate, false);
    const authority = openExisting(files.path);
      try {
      reconcileRestore(restored, authority, now + 1, 30 * 86_400_000);
        expect(
          restored
            .prepare('SELECT id,due_at,schedule_key,hint_claimed FROM personal_reminders')
            .get(),
        ).toEqual({
          id: 12,
          due_at: dueAt,
          schedule_key: version === 59 ? 'relative:1' : null,
          hint_claimed: version === 59 ? 1 : 0,
        });
        expect(
          restored
            .prepare(
              'SELECT state,receipt,send_id,definite_failure FROM personal_reminder_parts ORDER BY part',
            )
            .all(),
        ).toEqual([
          { state: 'confirmed', receipt: '80', send_id: 8, definite_failure: 0 },
          version === 59
            ? { state: 'ready', receipt: null, send_id: 9, definite_failure: 1 }
            : { state: 'unknown', receipt: '81', send_id: 9, definite_failure: 0 },
        ]);
        expect(restored.pragma('foreign_key_check')).toEqual([]);
      } finally {
      authority.close();
        restored.close();
      }
    } finally {
      live.close();
      files.cleanup();
    }
  },
);

test('восстановление берёт актуальные права и отметки и сохраняет отмену отзыва при повторе', async () => {
  const files = storageFixture();
  const snapshot = join(files.directory, 'admin-snapshot.sqlite');
  const candidate = join(files.directory, 'admin-candidate.sqlite');
  const live = await openStorage(files.path);
  const now = Date.now();
  const ownerId = 'vk:73' as const;
  const subject = 'vk:42' as const;
  const connect = (storage: typeof live) =>
    createAuthorizationService({
      config: { ownerId, reasonMaxLength: 500, reasonRetentionDays: 90 },
      store: storage.authorization,
      now: () => now,
    });
  const service = await connect(live);
  const event = (messageId: number) => ({ sourceChatId: ownerId, messageId, timestamp: now });
  const revoke = { kind: 'revoke', userId: subject, reason: 'Синтетическая причина' } as const;
  const current = () => true;
  try {
    const first = scopeFor(live, 'vk:a');
    const second = scopeFor(live, 'vk:b');
    for (const scope of [first, second])
      await live.chats.create(scope, { createdAt: now, enabled: true, responseMode: 'normal' });
    await service.applyTrustedInitialAuthorities(first, { creatorId: subject });
    const owner = service.context({ scope: first, kind: 'owner', userId: ownerId });
    expect(await service.executeAdminCommand(owner, revoke, event(10), current)).toMatchObject({
      value: { status: 'revoked' },
    });
    const authority = openExisting(files.path);
    try {
      await createSnapshot(authority, snapshot, 'one', now);
      expect(
        await service.executeAdminCommand(
          owner,
          { kind: 'restore', userId: subject },
          event(11),
          current,
        ),
      ).toMatchObject({ value: { status: 'restored' } });
      await service.applyTrustedInitialAuthorities(first, { creatorId: subject });
      const other = service.context({ scope: second, kind: 'owner', userId: ownerId });
      const membership = await service.confirmMembership(second, subject);
      const grant = { kind: 'grant', userId: subject, membership } as const;
      expect(await service.executeAdminCommand(other, grant, event(10), current)).toMatchObject({
        value: { status: 'granted' },
      });
      await openCandidate(snapshot, candidate, 'one', now + 1);
      const staged = openExisting(candidate, false);
      try {
        expect(reconcileRestore(staged, authority, now + 1, 30 * 86_400_000).access).toBe('full');
      } finally {
        staged.close();
      }
    } finally {
      authority.close();
    }
    const restored = await openStorage(candidate);
    try {
      const auth = await connect(restored);
      try {
        const scope = scopeFor(restored, 'vk:a');
        const neighbor = scopeFor(restored, 'vk:b');
        const owner = auth.context({ scope, kind: 'owner', userId: ownerId });
        expect(await auth.audit(owner, subject)).toEqual({ allowed: true, value: null });
        expect(await auth.executeAdminCommand(owner, revoke, event(10), current)).toMatchObject({
          value: { status: 'duplicate' },
        });
        expect(await auth.audit(owner, subject)).toEqual({ allowed: true, value: null });
        expect(await restored.authorization.transaction(scope, (tx) => tx.bases(subject))).toEqual([
          'creator',
        ]);
        expect(
          await restored.authorization.transaction(neighbor, (tx) => tx.bases(subject)),
        ).toEqual(['explicit']);
        const other = auth.context({ scope: neighbor, kind: 'owner', userId: ownerId });
        const membership = await auth.confirmMembership(neighbor, subject);
        expect(
          await auth.executeAdminCommand(
            other,
            { kind: 'grant', userId: subject, membership },
            event(10),
            current,
          ),
        ).toMatchObject({ value: { status: 'duplicate' } });
      } finally {
        auth.dispose();
      }
    } finally {
      await restored.close();
    }
  } finally {
    service.dispose();
    await live.close();
    files.cleanup();
  }
});

test('снимок версии 56 получает действующие отметки команд и исходную границу обновления', async () => {
  const files = storageFixture();
  const snapshot = join(files.directory, 'saved');
  const candidate = join(files.directory, 'candidate');
  const a = 'vk:a';
  const b = 'vk:b';
  const ownerId = 'vk:1' as const;
  const now = Date.now();
  const cutoff = Math.floor(now / 1000) * 1000;
  const config = { ownerId, reasonMaxLength: 500, reasonRetentionDays: 90 };
  const current = () => true;
  const greet = { kind: 'greeting', enabled: true } as const;
  const groupEvent = { sourceChatId: a, messageId: 200, timestamp: cutoff } as const;
  const privateEvent = { ...groupEvent, sourceChatId: ownerId } as const;
  const readCommands = (db: Database.Database) =>
    db
      .prepare(
        'SELECT chat_id AS chat, message_id AS id, source_chat_id AS source, legacy_before AS cutoff FROM chat_control_commands ORDER BY chat_id, message_id, source_chat_id',
      )
      .all();
  try {
    const original = new Database(files.path);
    try {
      migrate(original, migrations.slice(0, 56));
      original.exec(`
        UPDATE lifecycle_clock SET value=2;
        INSERT INTO chat_connections(chat_id,generation,revision,state)
          VALUES ('${a}',1,0,'active'),('${b}',2,0,'active');
        INSERT INTO chats(chat_id,timezone,enabled,created_at,response_mode)
          VALUES ('${a}','UTC',1,1,'normal'),('${b}','UTC',1,1,'active');
        INSERT INTO chat_control_commands(chat_id,generation,actor_id,message_id)
          VALUES ('${a}',1,'${ownerId}',200),('${b}',2,'${ownerId}',200);
      `);
    } finally {
      original.close();
    }
    const source = openExisting(files.path);
    try {
      await createSnapshot(source, snapshot, 'one', now);
    } finally {
      source.close();
    }
    const live = await openStorage(files.path);
    try {
      const writer = openExisting(files.path, false);
      try {
        // Моделируем разные секунды обновления рабочей БД и снимка.
        writer.prepare('UPDATE chat_control_commands SET legacy_before=?').run(cutoff);
      } finally {
        writer.close();
      }
      const service = await createAuthorizationService({
        config,
        store: live.authorization,
        now: () => now,
      });
      try {
        const first = service.context({ scope: scopeFor(live, a), userId: ownerId });
        const second = service.context({ scope: scopeFor(live, b), userId: ownerId });
        expect(await service.controlChat(first, greet, current, groupEvent)).toMatchObject({
          value: { status: 'applied' },
        });
        expect(
          await service.controlChat(first, { ...greet, enabled: false }, current, {
            ...groupEvent,
            messageId: 201,
          }),
        ).toMatchObject({ value: { status: 'applied' } });
        expect(
          await service.controlChat(second, greet, current, { ...groupEvent, sourceChatId: b }),
        ).toMatchObject({ value: { status: 'applied' } });
      } finally {
        service.dispose();
      }
    } finally {
      await live.close();
    }
    await openCandidate(snapshot, candidate, 'one', now + 1);
    const authority = openExisting(files.path);
    const staged = openExisting(candidate, false);
    try {
      expect(
        staged.prepare('SELECT min(legacy_before) FROM chat_control_commands').pluck().get(),
      ).toBeGreaterThan(cutoff);
      expect(reconcileRestore(staged, authority, now + 1, 30 * 86_400_000).access).toBe('full');
      expect(readCommands(staged)).toEqual(readCommands(authority));
      expect(staged.pragma('foreign_key_check')).toEqual([]);
    } finally {
      staged.close();
      authority.close();
    }
    const restored = await openStorage(candidate);
    try {
      const service = await createAuthorizationService({
        config,
        store: restored.authorization,
        now: () => now + 2,
      });
      try {
        const scope = scopeFor(restored, a);
        const other = scopeFor(restored, b);
        const group = service.context({ scope, userId: ownerId });
        const owner = service.context({ scope, userId: ownerId, kind: 'owner' });
        const controls = chatControlStore(restored);
        const otherState = controls.read(other);
        expect(otherState).toMatchObject({ mode: 'active', greetingEnabledFrom: 200 });
        expect(await service.controlChat(group, greet, current, groupEvent)).toMatchObject({
          value: { status: 'duplicate' },
        });
        const off = { kind: 'off' } as const;
        expect(
          await service.controlChat(owner, off, current, {
            ...privateEvent,
            timestamp: cutoff - 1000,
          }),
        ).toMatchObject({ value: { status: 'duplicate' } });
        expect(controls.read(scope)).toMatchObject({ enabled: true, greetingEnabledAt: null });
        expect(await service.controlChat(owner, off, current, privateEvent)).toMatchObject({
          value: { status: 'applied', state: { enabled: false } },
        });
        expect(controls.read(other)).toEqual(otherState);
      } finally {
        service.dispose();
      }
    } finally {
      await restored.close();
    }
  } finally {
    files.cleanup();
  }
});

test('сброшенное поколение исключено, отзыв действует, вторая беседа сохраняет историю', async () => {
  const f = storageFixture(),
    storage = await openStorage(f.path);
  try {
    const first = scopeFor(storage, 'vk:a'),
      keep = scopeFor(storage, 'vk:b');
    for (const scope of [first, keep]) {
      await storage.chats.create(scope, { createdAt: 1, enabled: true, responseMode: 'normal' });
      await storage.messages.append(scope, {
        chatId: scope.chatId,
        messageId: '1',
        userId: 'vk:u',
        authorName: '',
        role: 'user',
        text: scope.chatId,
        timestamp: 1,
      });
    }
    const writer = openExisting(f.path, false);
    writer
      .prepare(
        "INSERT INTO bot_admin_grants(chat_id,user_id,basis,granted_at,granted_by) VALUES('vk:b','vk:u','explicit',1,'vk:o')",
      )
      .run();
    writer
      .prepare(
        "INSERT INTO paused_reset_requests(code,owner_id,event_id,chat_id,generation,revision,send_id,state,receipt,expires_at) VALUES('old','vk:o',7,?, ?,0,9,'ready',10,900010)",
      )
      .run(first.chatId, first.generation);
    writer.close();
    const source = openExisting(f.path);
    const saved = join(f.directory, 'saved'),
      temp = join(f.directory, 'candidate');
    try {
      await createSnapshot(source, saved, 'one', 10);
      await openCandidate(saved, temp, 'one', 11);
      lifecycleBackend(storage).ownerDecision(lifecycleBackend(storage).begin(first.chatId), 'new');
      const admin = openExisting(f.path, false);
      admin.exec(
        "DELETE FROM bot_admin_grants WHERE chat_id='vk:b'; INSERT INTO bot_admin_revocations VALUES('vk:b','vk:u','vk:o',12); INSERT INTO bot_admin_controls VALUES('vk:b',1)",
      );
      admin.close();
      const staged = openExisting(temp, false);
      try {
        const reconcile = source.transaction(() =>
          staged.transaction(() => reconcileConnections(staged, source))(),
        );
        expect(reconcile()).toEqual({ access: 'partial', admitted: 1, closed: 1 });
        expect(
          staged.prepare("SELECT state FROM paused_reset_requests WHERE code='old'").pluck().get(),
        ).toBe('closed');
        expect(reconcile()).toEqual({ access: 'partial', admitted: 1, closed: 1 });
        expect(staged.prepare('SELECT text FROM messages').pluck().all()).toEqual(['vk:b']);
        expect(staged.prepare('SELECT count(*) FROM bot_admin_grants').pluck().get()).toBe(0);
        expect(staged.prepare('SELECT user_id FROM active_admin_denials').pluck().all()).toEqual([
          'vk:u',
        ]);
        expect(
          staged.prepare('SELECT value FROM lifecycle_clock').pluck().get(),
        ).toBeGreaterThanOrEqual(
          source.prepare('SELECT value FROM lifecycle_clock').pluck().get() as number,
        );
        const ownCopy = openExisting(saved);
        try {
          expect(() =>
            ownCopy.transaction(() =>
              staged.transaction(() => reconcileConnections(staged, ownCopy))(),
            )(),
          ).toThrow('untrusted_source');
        } finally {
          ownCopy.close();
        }
      } finally {
        staged.close();
      }
    } finally {
      source.close();
    }
  } finally {
    await storage.close();
    f.cleanup();
  }
});

test('очистка без личного удаления, свежий срок и личное удаление применяются до поиска и выгрузки', async () => {
  const f = storageFixture(),
    app = await openStorage(f.path),
    now = Date.now(),
    day = 86_400_000;
  try {
    const a = scopeFor(app, 'vk:a'),
      b = scopeFor(app, 'vk:b');
    for (const scope of [a, b])
      await app.chats.create(scope, { createdAt: now, enabled: true, responseMode: 'normal' });
    const input = (
      chatId: typeof a.chatId,
      messageId: string,
      text: string,
      timestamp = now,
      userId: 'vk:1' | 'vk:2' = 'vk:1',
    ) => ({ chatId, messageId, userId, authorName: '', text, role: 'user' as const, timestamp });
    await app.messages.append(a, input(a.chatId, '1', 'очищено'));
    await app.messages.append(b, input(b.chatId, '2', 'удалено'));
    await app.messages.append(b, input(b.chatId, '3', 'доступно', now, 'vk:2'));
    await app.messages.append(b, input(b.chatId, '4', 'просрочено', now - 12 * day, 'vk:2'));
    const latest = openExisting(f.path);
    const snapshot = join(f.directory, 'saved'),
      candidate = join(f.directory, 'candidate');
    try {
      await createSnapshot(latest, snapshot, 'local', now);
      const after = await app.messages.append(a, input(a.chatId, '5', 'после снимка'));
      const control = openExisting(f.path, false);
      control
        .prepare(
          'INSERT INTO history_retention_boundaries(chat_id,generation,cleared_through) VALUES (?,?,?)',
        )
        .run(a.chatId, a.generation, after.id);
      control.prepare('INSERT OR REPLACE INTO history_retention_policy VALUES (1,?)').run(10 * day);
      control.close();
      const pd = personalDataStore(app);
      const request = pd.requestDeletion(b, 'vk:1', 'operation', now);
      expect(pd.confirmDeletion(b, 'vk:1', request.code, now + 1)).toBe(true);
      await openCandidate(snapshot, candidate, 'local', now + 2);
      const staged = openExisting(candidate, false);
      try {
        for (let attempt = 0; attempt < 2; attempt++)
          expect(reconcileRestore(staged, latest, now + 2, 30 * day).access).toBe('full');
      } finally {
        staged.close();
      }
      const restored = await openStorage(candidate);
      try {
        const ca = scopeFor(restored, 'vk:a'),
          cb = scopeFor(restored, 'vk:b');
        expect(await restored.contextMessages.search(ca, 'очищено', 4, 256)).toEqual([]);
        expect(await restored.contextMessages.search(cb, 'удалено', 4, 256)).toEqual([]);
        expect(await restored.messages.list(cb, { limit: 10 })).toMatchObject([
          { text: 'доступно' },
        ]);
        expect(personalDataStore(restored).export(cb, 'vk:1', now + 2).messages).toEqual([]);
        const fresh = await restored.messages.append(ca, input(ca.chatId, '6', 'новое', now + 3));
        expect(fresh.id).toBeGreaterThan(after.id);
        expect(await restored.contextMessages.search(ca, 'новое', 4, 256)).toHaveLength(1);
      } finally {
        await restored.close();
      }
    } finally {
      latest.close();
    }
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('личное ограничение видимости обычного поля после снимка переживает восстановление', async () => {
  const f = await profileFixture(),
    newer = openExisting(f.path),
    now = Date.now();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const original = await f.message(scope, alice, '101', now);
    expect(await f.change(scope, alice, alice, original, set('city', 'Пермь'))).toMatchObject({
      value: 'recorded',
    });
    const saved = f.path + '.backup',
      candidate = f.path + '.stage';
    await createSnapshot(newer, saved, 'one', now);
    const update = await f.message(scope, alice, '102', now + 1);
    expect(
      await f.change(scope, alice, alice, update, {
        kind: 'visibility',
        fieldKey: 'city',
        visibility: 'bot',
      }),
    ).toMatchObject({ value: 'recorded' });
    await openCandidate(saved, candidate, 'one', now + 2);
    const staged = openExisting(candidate, false);
    try {
      expect(reconcileRestore(staged, newer, now + 2, 30 * 86400000).access).toBe('full');
    } finally {
      staged.close();
    }
    const app = await openStorage(candidate);
    try {
      const subject = scopeFor(app, scope.chatId);
      expect(
        await app.authorization.transaction(subject, (tx) => tx.readOwnProfile(alice, now + 2)),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ value: 'Пермь', visibility: 'bot' })]),
      );
    } finally {
      await app.close();
    }
  } finally {
    newer.close();
    await f.close();
  }
});

test('восстановление закрывает ожидающие ответы о периоде и замене вопросов', async () => {
  const f = await profileFixture();
  const newer = openExisting(f.path),
    now = Date.now();
  try {
    const scope = await f.chat();
    const input = await f.message(scope, alice, '101', now);
    const { id: prompt } = await f.storage.messages.append(scope, {
      chatId: scope.chatId,
      userId: 'vk:-314',
      role: 'assistant',
      authorName: 'Бот',
      messageId: '102',
      text: 'Подтвердите',
      timestamp: now,
    });
    lifecycleBackend(f.storage).transaction(scope, (db) => {
      db.prepare(
        'INSERT INTO recap_clarifications(chat_id,generation,receipt,user_id,message_id,root_id,source_id) VALUES(?,?,?,?,?,?,?)',
      ).run(scope.chatId, scope.generation, '102', alice, prompt, input, input);
      db.prepare(
        'INSERT INTO questionnaire_editor_prompts(chat_id,generation,receipt,message_id,actor_id,shown_revision,proposal,proposal_source_id) VALUES(?,?,?,?,?,1,?,?)',
      ).run(scope.chatId, scope.generation, '102', prompt, alice, 'Один вопрос?', input);
    });
    const backup = f.path + '.backup',
      candidate = f.path + '.stage';
    await createSnapshot(newer, backup, 'one', now);
    await openCandidate(backup, candidate, 'one', now + 1);
    const staged = openExisting(candidate, false);
    try {
      expect(reconcileRestore(staged, newer, now + 2, 30 * 86400000).access).toBe('full');
      expect(staged.prepare('SELECT count(*) FROM recap_clarifications').pluck().get()).toBe(0);
      expect(
        staged.prepare('SELECT actor_id,proposal FROM questionnaire_editor_prompts').raw().get(),
      ).toEqual([null, null]);
    } finally {
      staged.close();
    }
  } finally {
    newer.close();
    await f.close();
  }
});

test.each(['keep', 'erase', 'reopened'] as const)(
  'сверка перенесла актуальный исход %s и обе квитанции',
  async (outcome) => {
    const files = storageFixture();
    const live = await openStorage(files.path);
    const authority = openExisting(files.path);
    const now = Date.now();
    try {
      const a = scopeFor(live, 'vk:a');
      const b = scopeFor(live, 'vk:b');
      const privacy = personalDataStore(live);
      for (const scope of [a, b]) {
        for (const [messageId, userId] of [
          ['1', 'vk:11'],
          ['2', 'vk:12'],
        ] as const) {
          await live.messages.append(scope, {
            chatId: scope.chatId,
            messageId,
            userId,
            role: 'user',
            authorName: '',
            text: 'Упоминание',
            timestamp: now,
          });
        }
      }
      const req = privacy.requestDeletion(a, 'vk:11', 'delete', now);
      expect(privacy.confirmDeletion(a, 'vk:11', req.code, now)).toBe(true);
      expect(privacy.reportMessage(a, 'vk:11', '2', 401)).toBe(true);
      if (outcome === 'reopened') {
        expect(privacy.resolveDisputed(a, '2', 'keep')).toBe(true);
        privacy.cleanup(now);
        expect(privacy.status(a, 'vk:11', now)).toContain('проверена');
      }
      const path = join(files.directory, 'staged');
      await authority.backup(path);
      privacy.reportMessage(a, 'vk:11', '2', 402);
      if (outcome !== 'reopened') expect(privacy.resolveDisputed(a, '2', outcome)).toBe(true);
      privacy.cleanup(now);
      const staged = openExisting(path, false);
      try {
        for (let pass = 0; pass < 2; pass++) {
          reconcileStagedPersonalData(staged, authority, now);
          expect(
            staged
              .prepare(
                'SELECT source_message_id FROM personal_dispute_reports ORDER BY source_message_id',
              )
              .pluck()
              .all(),
          ).toEqual([401, 402]);
          expect(
            staged
              .prepare('SELECT state FROM personal_dispute_cases WHERE code=?')
              .pluck()
              .get(req.code),
          ).toBe(outcome === 'reopened' ? 'open' : outcome);
          const visible = staged
            .prepare(
              "SELECT chat_id FROM personal_visible_messages WHERE platform_message_id='2' ORDER BY chat_id",
            )
            .pluck()
            .all();
          expect(visible).toEqual(outcome === 'keep' ? ['vk:a', 'vk:b'] : ['vk:b']);
          expect(
            staged
              .prepare('SELECT count(*) FROM personal_hidden_messages WHERE disputed=1')
              .pluck()
              .get(),
          ).toBe(outcome === 'reopened' ? 1 : 0);
          expect(
            staged
              .prepare(
                "SELECT count(*) FROM messages WHERE chat_id='vk:a' AND platform_message_id='2'",
              )
              .pluck()
              .get(),
          ).toBe(outcome === 'erase' ? 0 : 1);
          expect(
            staged
              .prepare('SELECT verified_at IS NULL FROM personal_deletions WHERE code=?')
              .pluck()
              .get(req.code),
          ).toBe(outcome === 'reopened' ? 1 : 0);
          expect(staged.pragma('foreign_key_check')).toEqual([]);
        }
      } finally {
        staged.close();
      }
    } finally {
      authority.close();
      await live.close();
      files.cleanup();
    }
  },
);

test.each(['видна', 'отсутствует', 'скрыта', 'истекла', 'удалена', 'другая операция'] as const)(
  'старый спор из версии 57, в действующей базе реплика %s',
  async (condition) => {
    const files = storageFixture();
    const db = new Database(files.path);
    try {
      migrate(db, migrations.slice(0, 57));
      db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:a',1,1,'active'),('vk:b',2,1,'active');
        INSERT INTO personal_deletions(code,chat_id,generation,user_id,request_event,requested_at,confirmed_at,cutoff_id)
        VALUES('op','vk:a',1,'vk:1','1',0,1,4);
        INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
        VALUES('vk:a','2','vk:2','','user','Упоминание',1),('vk:b','2','vk:2','','user','Упоминание',1);
        INSERT INTO personal_hidden_messages VALUES(1,'op',1)`);
      const path = join(files.directory, 'staged');
      await db.backup(path);
      // Старое «оставить» не оставляло квитанции и происходило до обновления рабочей БД.
      db.exec('DELETE FROM personal_hidden_messages');
      if (condition === 'другая операция')
        db.exec("UPDATE personal_deletions SET code='elsewhere',request_event='another-request'");
      if (condition === 'скрыта')
        db.exec(`INSERT INTO personal_deletions(code,chat_id,generation,user_id,request_event,requested_at,confirmed_at,cutoff_id)
        VALUES('other','vk:a',1,'vk:3','3',0,1,4); INSERT INTO personal_hidden_messages VALUES(1,'other',1)`);
      if (condition === 'отсутствует') db.exec("DELETE FROM messages WHERE chat_id='vk:a'");
      if (condition === 'истекла')
        db.exec(
          "INSERT INTO history_retention_boundaries(chat_id,generation,expired_through) VALUES('vk:a',1,1)",
        );
      if (condition === 'удалена')
        db.exec("INSERT INTO history_deleted_inputs VALUES('vk:a',1,'2')");
      if (condition === 'видна') db.exec("UPDATE messages SET id=3 WHERE chat_id='vk:a'");
      migrate(db);
      const authority = openExisting(files.path);
      const staged = openExisting(path, false);
      try {
        for (let pass = 0; pass < 2; pass++) {
          reconcileStagedPersonalData(staged, authority, 4);
          expect(
            staged
              .prepare(
                "SELECT count(*) FROM personal_visible_messages WHERE chat_id='vk:a' AND platform_message_id='2'",
              )
              .pluck()
              .get(),
          ).toBe(condition === 'видна' ? 1 : 0);
          expect(
            staged
              .prepare(
                "SELECT platform_message_id FROM personal_visible_messages WHERE chat_id='vk:b'",
              )
              .pluck()
              .all(),
          ).toEqual(['2']);
          expect(staged.pragma('foreign_key_check')).toEqual([]);
        }
      } finally {
        staged.close();
        authority.close();
      }
    } finally {
      db.close();
      files.cleanup();
    }
  },
);

test('снимок до подтверждения удаления сохраняет ранний ответ, независимый от более поздней жалобы', async () => {
  const files = storageFixture();
  const live = await openStorage(files.path);
  const authority = openExisting(files.path);
  const now = Date.now();
  try {
    const a = scopeFor(live, 'vk:a');
    const privacy = personalDataStore(live);
    for (const [messageId, userId, role] of [
      ['1', 'vk:2', 'user'],
      ['2', 'vk:-5', 'assistant'],
      ['3', 'vk:1', 'user'],
    ] as const) {
      await live.messages.append(a, {
        chatId: a.chatId,
        messageId,
        userId,
        role,
        authorName: '',
        text: 'Запись',
        timestamp: now,
      });
    }
    const path = join(files.directory, 'before');
    await authority.backup(path);
    const req = privacy.requestDeletion(a, 'vk:1', 'delete', now);
    expect(privacy.confirmDeletion(a, 'vk:1', req.code, now)).toBe(true);
    expect(privacy.reportMessage(a, 'vk:1', '1', 22)).toBe(true);
    expect(privacy.disputed(a)).toEqual([{ messageId: '1' }]);
    const staged = openExisting(path, false);
    try {
      reconcileStagedPersonalData(staged, authority, now);
      expect(
        staged
          .prepare("SELECT platform_message_id FROM personal_visible_messages WHERE chat_id='vk:a'")
          .pluck()
          .all(),
      ).toEqual(['2']);
    } finally {
      staged.close();
    }
  } finally {
    authority.close();
    await live.close();
    files.cleanup();
  }
});
