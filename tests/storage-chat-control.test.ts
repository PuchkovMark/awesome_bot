import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createAuthorizationService, createLifecycleService } from '../src/core/index';
import { openStorage } from '../src/storage/index';
import { chatControlStore } from '../src/storage/chat-control-store';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import { storageFixture } from './helpers/storage-fixture';

const chat = 'vk:2000000010',
  neighbor = 'vk:2000000011',
  ownerId = 'vk:1';

test('миграция сохраняет старую очередь, а выключение аннулирует её и не теряет паузу', async () => {
  const files = storageFixture(),
    original = new Database(files.path);
  try {
    migrate(original, migrations.slice(0, 15));
    original.exec(`UPDATE lifecycle_clock SET value=2;
      INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('${chat}',1,0,'active'),('${neighbor}',2,0,'active');
      INSERT INTO chats(chat_id,timezone,enabled,created_at,response_mode) VALUES ('${chat}','UTC',1,1,'active'),('${neighbor}','UTC',1,1,'normal');
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
        VALUES ('${chat}','1','vk:5','','user','Синтетическая реплика',1);
      INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,route_kind,route_mode,route_group)
        VALUES ('${chat}',1,1,1,3000000,'queued','mention','active',1);`);
  } finally {
    original.close();
  }
  let storage = await openStorage(files.path);
  const lifecycle = () =>
    createLifecycleService({
      storage,
      ownerId,
      source: {
        async observe() {
          return { confidence: 'unavailable', bot: 'unknown' };
        },
      },
    });
  const diagnostic = new Database(files.path);
  try {
    const current = lifecycle().current(chat);
    const store = chatControlStore(storage);
    expect(store.read(current)).toMatchObject({
      enabled: true,
      mode: 'active',
      autonomousDisabled: false,
      responseRevision: 0,
      invitationEnabledAt: null,
    });
    expect((await storage.messages.list(current, { limit: 5 }))[0]?.text).toBe(
      'Синтетическая реплика',
    );
    const waiting = diagnostic.prepare(
      'SELECT state,outcome,control_revision AS rev FROM queue_jobs',
    );
    expect(waiting.get()).toEqual({ state: 'queued', outcome: null, rev: 0 });
    const auth = await createAuthorizationService({
      config: { ownerId, reasonMaxLength: 500, reasonRetentionDays: 90 },
      store: storage.authorization,
      now: () => 100,
    });
    try {
      const context = auth.context({ scope: current, userId: ownerId, kind: 'owner' });
      const event = (messageId: number) => ({
        sourceChatId: context.userId,
        messageId,
        timestamp: 100,
      });
      await auth.controlChat(context, { kind: 'pause' }, () => true, event(10));
      await auth.controlChat(context, { kind: 'greeting', enabled: true }, () => true, event(20));
      await auth.controlChat(context, { kind: 'invitation', enabled: true }, () => true, event(21));
      const received = store.capture(current);
      await auth.controlChat(context, { kind: 'off' }, () => true, event(11));
      const whileOff = store.capture(current);
      await auth.controlChat(context, { kind: 'on' }, () => true, event(12));
      expect(received().ordinary).toBe(false);
      expect(whileOff()).toEqual({ journal: false, ordinary: false });
      expect(store.capture(current)()).toEqual({ journal: true, ordinary: true });
      expect(waiting.get()).toEqual({ state: 'terminal', outcome: 'interrupted', rev: 0 });
    } finally {
      auth.dispose();
    }
    await storage.close();
    storage = await openStorage(files.path);
    const life = lifecycle();
    expect(chatControlStore(storage).read(life.current(chat))).toMatchObject({
      enabled: true,
      mode: 'active',
      pausedUntil: 900100,
      nextParticipantPause: 1800100,
      responseRevision: 1,
      invitationEnabledAt: 0,
      greetingEnabledAt: 0,
    });
    const replacement = life.decide(life.owner(chat, ownerId), 'new');
    expect(chatControlStore(storage).read(replacement)).toMatchObject({
      pausedUntil: null,
      responseRevision: 0,
      invitationEnabledAt: null,
      greetingEnabledAt: null,
      mode: 'normal',
    });
    expect(chatControlStore(storage).read(life.current(neighbor))).toMatchObject({
      enabled: true,
      mode: 'normal',
      invitationEnabledAt: null,
    });
    expect(diagnostic.prepare('SELECT count(*) AS n FROM chat_control_commands').get()).toEqual({
      n: 0,
    });
  } finally {
    diagnostic.close();
    await storage.close();
    files.cleanup();
  }
});

test('обновление с 56 отличает старые повторы от новых совпадений номера и сохраняет границу', async () => {
  const files = storageFixture();
  const diagnostic = new Database(files.path);
  diagnostic.pragma('foreign_keys = ON');
  migrate(diagnostic, migrations.slice(0, 56));
  diagnostic.exec(`
    UPDATE lifecycle_clock SET value=2;
    INSERT INTO chat_connections(chat_id,generation,revision,state)
      VALUES ('${chat}',1,0,'active'),('${neighbor}',2,0,'active');
    INSERT INTO chats(chat_id,timezone,enabled,created_at,response_mode)
      VALUES ('${chat}','UTC',1,1,'active'),('${neighbor}','UTC',1,1,'normal');
    INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      VALUES ('${chat}','40','${ownerId}','','user','Синтетическая реплика владельца',1);
    INSERT INTO chat_control_commands(chat_id,generation,actor_id,message_id)
      VALUES ('${chat}',1,'${ownerId}',40),('${neighbor}',2,'${ownerId}',40);
  `);
  const startedAt = Date.now();
  let storage = await openStorage(files.path);
  const finishedAt = Date.now();
  const cutoff = diagnostic
    .prepare('SELECT legacy_before FROM chat_control_commands WHERE chat_id=?')
    .pluck()
    .get(chat) as number;
  const connect = () =>
    createAuthorizationService({
      config: { ownerId, reasonMaxLength: 500, reasonRetentionDays: 90 },
      store: storage.authorization,
      now: () => cutoff,
    });
  let auth = await connect();
  try {
    const commands = diagnostic.prepare(
      'SELECT source_chat_id AS source, message_id AS messageId, legacy_before AS cutoff FROM chat_control_commands WHERE chat_id=? ORDER BY message_id, source_chat_id',
    );
    expect(commands.all(chat)).toEqual([{ source: null, messageId: 40, cutoff }]);
    expect(commands.all(neighbor)).toEqual(commands.all(chat));
    expect(cutoff % 1000).toBe(0);
    expect(cutoff).toBeGreaterThan(startedAt);
    expect(cutoff).toBeLessThanOrEqual(finishedAt + 1000);
    const controls = (id: typeof chat | typeof neighbor) =>
      chatControlStore(storage).read(lifecycleBackend(storage).current(id));
    const context = (id: typeof chat | typeof neighbor, kind: 'chat' | 'owner') =>
      auth.context({ scope: lifecycleBackend(storage).current(id), userId: ownerId, kind });
    const current = () => true;
    const groupEvent = { sourceChatId: chat, messageId: 40, timestamp: cutoff } as const;
    const dmEvent = { ...groupEvent, sourceChatId: ownerId } as const;
    const greeting = { kind: 'greeting', enabled: true } as const;
    const off = { kind: 'off' } as const;
    expect(controls(chat)).toMatchObject({
      enabled: true,
      mode: 'active',
      greetingEnabledAt: null,
    });
    expect(
      await auth.controlChat(context(chat, 'chat'), greeting, current, {
        ...groupEvent,
        timestamp: cutoff - 1001,
      }),
    ).toMatchObject({ value: { status: 'duplicate' } });
    expect(
      await auth.controlChat(context(chat, 'owner'), off, current, {
        ...dmEvent,
        timestamp: cutoff - 1000,
      }),
    ).toMatchObject({ value: { status: 'duplicate' } });
    expect(controls(chat)).toMatchObject({ enabled: true, greetingEnabledAt: null });
    expect(
      await auth.controlChat(context(chat, 'chat'), greeting, current, groupEvent),
    ).toMatchObject({ value: { status: 'applied', state: { greetingEnabledFrom: 40 } } });
    expect(await auth.controlChat(context(chat, 'owner'), off, current, dmEvent)).toMatchObject({
      value: { status: 'applied', state: { enabled: false } },
    });
    await auth.controlChat(context(chat, 'owner'), { kind: 'on' }, current, {
      ...dmEvent,
      messageId: 41,
    });
    await auth.controlChat(context(chat, 'chat'), { ...greeting, enabled: false }, current, {
      ...groupEvent,
      messageId: 41,
    });
    await auth.controlChat(context(neighbor, 'chat'), greeting, current, {
      ...groupEvent,
      sourceChatId: neighbor,
    });
    expect(controls(neighbor)).toMatchObject({
      enabled: true,
      mode: 'normal',
      greetingEnabledFrom: 40,
    });
    const saved = commands.all(chat);
    expect(saved.slice(0, 3)).toEqual([
      { source: null, messageId: 40, cutoff },
      { source: ownerId, messageId: 40, cutoff: null },
      { source: chat, messageId: 40, cutoff: null },
    ]);
    auth.dispose();
    await storage.close();
    storage = await openStorage(files.path);
    auth = await connect();
    expect(
      await auth.controlChat(context(chat, 'chat'), greeting, current, groupEvent),
    ).toMatchObject({ value: { status: 'duplicate' } });
    expect(
      await auth.controlChat(context(chat, 'owner'), off, current, {
        ...dmEvent,
        timestamp: cutoff + 1000,
      }),
    ).toMatchObject({ value: { status: 'duplicate' } });
    expect(controls(chat)).toMatchObject({ enabled: true, greetingEnabledAt: null });
    expect(commands.all(chat)).toEqual(saved);

    diagnostic.exec(`
      CREATE TRIGGER reject_control_update BEFORE UPDATE OF enabled ON chats
      WHEN OLD.chat_id='${chat}' AND NEW.enabled=0
      BEGIN SELECT RAISE(ABORT, 'test control failure'); END;
    `);
    const anotherOff = { ...dmEvent, messageId: 42 };
    await expect(
      auth.controlChat(context(chat, 'owner'), off, current, anotherOff),
    ).rejects.toThrow();
    expect(commands.all(chat)).toEqual(saved);
    expect(controls(chat).enabled).toBe(true);
    diagnostic.exec('DROP TRIGGER reject_control_update');
    expect(await auth.controlChat(context(chat, 'owner'), off, current, anotherOff)).toMatchObject({
      value: { status: 'applied', state: { enabled: false } },
    });

    const personal = personalDataStore(storage);
    const scope = context(chat, 'chat').scope;
    const deletion = personal.requestDeletion(scope, ownerId, 'test-delete', cutoff);
    expect(personal.confirmDeletion(scope, ownerId, deletion.code, cutoff + 1)).toBe(true);
    expect(commands.all(chat)).toEqual([]);
    expect(commands.all(neighbor)).toEqual([
      { source: null, messageId: 40, cutoff },
      { source: neighbor, messageId: 40, cutoff: null },
    ]);
    expect(controls(neighbor).greetingEnabledFrom).toBe(40);
    const life = lifecycleBackend(storage);
    life.ownerDecision(life.begin(neighbor), 'new');
    expect(commands.all(neighbor)).toEqual([]);
    expect(controls(chat)).toMatchObject({ enabled: false, mode: 'active' });
    expect(diagnostic.pragma('foreign_key_check')).toEqual([]);
  } finally {
    auth.dispose();
    diagnostic.close();
    await storage.close();
    files.cleanup();
  }
});
