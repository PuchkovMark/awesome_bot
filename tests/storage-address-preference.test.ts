import { expect, test } from 'vitest';
import { addressPreferenceStore } from '../src/storage/address-preference-store';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import { openConnection } from '../src/storage/connection';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { participantFixture } from './helpers/participant-fixture';
import { storageFixture } from './helpers/storage-fixture';

const group = 'vk:2000000011';
const other = 'vk:2000000012';
const first = 'vk:42';
const second = 'vk:43';
const notice = {
  provider: 'OpenCode Go',
  dataPolicy: 'history',
  storagePolicy: 'test',
  detailsText: 'Тест',
  detailsUrl: 'https://example.test/info',
  ownerContact: 'Тест',
  profileNotice: 'Тестовое раскрытие о профиле',
  change: 'material',
} as const;

test('выбор переживает перезапуск, меняется только у автора и не восстанавливается старым событием', async () => {
  const files = storageFixture();
  const legacy = await openConnection(files.path, (db) => migrate(db, migrations.slice(0, 26)));
  try {
    legacy.run((db) => {
      const f = participantFixture(db);
      f.chat(group);
      db.prepare('UPDATE chats SET enabled=1 WHERE chat_id=?').run(group);
      for (const author of [first, second]) {
        f.participant(group, author);
        f.profile(group, author);
        f.fact(group, author, { fieldKey: 'nickname', value: 'Рысь', sourceKind: 'self' });
        db.prepare(
          `INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
          VALUES(?,?,?,'Саша Иванов','user','Данные',1)`,
        ).run(group, author, author);
      }
    });
  } finally {
    legacy.close();
  }
  let storage = await openStorage(files.path);
  try {
    let registry = addressPreferenceStore(storage);
    let current = scopeFor(storage, group);
    const next = scopeFor(storage, other),
      dm = scopeFor(storage, first);
    const disclosures = disclosureStore(storage);
    const version = disclosures.register(notice, 10);
    for (const scope of [current, next, dm]) {
      await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 10 });
      const row = disclosures.ensure(scope, 'introduction', version);
      expect(
        disclosures.finish(
          scope,
          disclosures.claim(scope, row.id, 'test', 20)!,
          'delivered',
          20,
          null,
          '20',
        ),
      ).toBe(true);
    }
    expect(registry.resolve(current, first, 21, true)).toBeUndefined();
    const set = (
      scope: typeof current,
      user: typeof first | typeof second,
      form: string,
      sequence: number,
      isGroupChat = true,
    ) =>
      registry.change(
        scope,
        user,
        { sequence, at: 21, isGroupChat },
        { kind: 'set', form },
        () => true,
      );
    expect(set(current, first, 'Рысь', 10)).toBe('changed');
    expect(set(current, second, 'Рысь', 11)).toBe('changed');
    expect(set(next, first, 'Иней', 10)).toBe('changed');
    expect(set(dm, first, 'Клён', 10, false)).toBe('changed');
    expect(registry.resolve(current, first, 21, true)?.text).toBe('Рысь');
    const reference = registry.resolve(current, first, 21, true)!.reference;
    expect(
      registry.change(
        current,
        first,
        { sequence: 12, at: 22, isGroupChat: true },
        { kind: 'reset' },
        () => true,
      ),
    ).toBe('changed');
    expect(registry.current(current, reference)).toBe(false);
    expect(set(current, first, 'Рысь', 10)).toBe('stale');
    await storage.close();
    storage = await openStorage(files.path);
    registry = addressPreferenceStore(storage);
    current = scopeFor(storage, group);
    expect(registry.resolve(current, first, 30, true)).toBeUndefined();
    expect(registry.resolve(current, second, 30, true)?.text).toBe('Рысь');
    expect(registry.resolve(scopeFor(storage, other), first, 30, true)?.text).toBe('Иней');
    expect(registry.resolve(scopeFor(storage, first), first, 30, false)?.text).toBe('Клён');
    const life = lifecycleBackend(storage);
    const changed = life.ownerDecision(life.begin(group), 'new');
    expect(registry.resolve(changed, second, 30, true)).toBeUndefined();
  } finally {
    await storage.close();
    files.cleanup();
  }
});

test('видимость, отказ от профиля и актуальность события действуют на запись и чтение', async () => {
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, group);
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
    const store = addressPreferenceStore(storage);
    const event = { sequence: 8, at: 30, isGroupChat: true };
    expect(store.change(scope, first, event, { kind: 'set', form: 'Тайна' }, () => true)).toBe(
      'blocked',
    );
    const notices = disclosureStore(storage);
    const version = notices.register(notice, 1);
    const item = notices.ensure(scope, 'introduction', version);
    notices.finish(scope, notices.claim(scope, item.id, 'test', 20)!, 'delivered', 20, null, '20');
    expect(store.change(scope, first, event, { kind: 'set', form: 'Тайна' }, () => false)).toBe(
      'blocked',
    );
    expect(store.change(scope, first, event, { kind: 'set', form: 'Тайна' }, () => true)).toBe(
      'changed',
    );
    const proof = store.resolve(scope, first, 30, true)!.reference;
    expect(
      store.change(
        scope,
        first,
        { ...event, sequence: 9 },
        { kind: 'visibility', value: 'bot' },
        () => true,
      ),
    ).toBe('changed');
    expect(store.resolve(scope, first, 30, true)).toBeUndefined();
    expect(store.current(scope, proof)).toBe(false);
    expect(
      store.change(
        scope,
        first,
        { ...event, sequence: 10 },
        { kind: 'set', form: 'Клён' },
        () => true,
      ),
    ).toBe('changed');
    expect(store.resolve(scope, first, 30, true)).toBeUndefined();
    personalDataStore(storage).disable(scope, first, 31);
    expect(
      store.change(
        scope,
        first,
        { ...event, sequence: 11, at: 32 },
        { kind: 'visibility', value: 'chat' },
        () => true,
      ),
    ).toBe('blocked');
  } finally {
    await storage.close();
  }
});
