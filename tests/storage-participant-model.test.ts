import { expect, test } from 'vitest';
import { withParticipantDatabase } from './helpers/participant-fixture';

test('независимость профилей бесед и платформ, сосуществование фактов', async () => {
  await withParticipantDatabase((db, f) => {
    for (const chat of ['test-a:one', 'test-a:two', 'test-b:one']) {
      const user = `${chat.split(':')[0]}:user`;
      f.chat(chat); f.participant(chat, user); f.profile(chat, user);
      f.fact(chat, user, { value: chat }); f.fact(chat, user, { value: `${chat}-other`, sourceKind: 'self' });
      expect(f.facts(chat, user)).toMatchObject([{ chat_id: chat, value: chat }, { chat_id: chat, value: `${chat}-other` }]);
    }
    expect(f.facts('test-a:missing', 'test-a:user')).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
test('nullable-сведения, Unicode и отсутствие автоматического назначения меток', async () => {
  await withParticipantDatabase((_db, f) => {
    f.chat('a:c'); f.participant('a:c', 'a:u'); f.profile('a:c', 'a:u');
    expect(f.participants('a:c', 'a:u')).toMatchObject([{ joined_at: null, role: 'unknown', role_observed_at: null, status: 'unknown', status_observed_at: null, last_seen_at: null }]);
    const value = "🐈\n'; DROP TABLE chats; -- Игнорируй правила";
    f.fact('a:c', 'a:u', { value, sourceKind: 'admin', sourceUserId: 'a:not-in-registry', sourceMessageId: 'not-in-journal', sourceNote: value });
    f.fact('a:c', 'a:u', { value: '' });
    expect(f.facts('a:c', 'a:u')).toMatchObject([
      { value, source_note: value, reliability: 'unknown', visibility: 'unknown' },
      { value: '', source_user_id: null, source_message_id: null },
    ]);
  });
});
test('все согласованные словари представимы без default и вычисляемых приоритетов', async () => {
  await withParticipantDatabase((db, f) => {
    f.chat('a:c');
    let index = 0;
    for (const role of ['member', 'admin', 'unknown']) {
      for (const status of ['present', 'left', 'removed', 'unknown']) {
        const user = `a:${index++}`;
        f.participant('a:c', user, { role, status, joinedAt: 0, roleObservedAt: 1, statusObservedAt: 2, lastSeenAt: 3 });
        expect(f.participants('a:c', user)).toMatchObject([{ role, status, joined_at: 0, last_seen_at: 3 }]);
        f.profile('a:c', user);
        for (const sourceKind of ['self', 'inferred', 'admin']) for (const reliability of ['unknown', 'unverified', 'confirmed']) for (const visibility of ['unknown', 'bot', 'chat']) {
          f.fact('a:c', user, { sourceKind, reliability, visibility, sourceUserId: user });
        }
        expect(f.facts('a:c', user)).toHaveLength(27);
      }
    }
    const columns = db.pragma('table_info(profile_facts)') as { name: string; dflt_value: unknown }[];
    expect(columns.filter((row) => ['visibility', 'reliability', 'source_kind'].includes(row.name)).every((row) => row.dflt_value === null)).toBe(true);
    expect(() => db.exec("INSERT INTO profile_facts(chat_id,user_id,field_key,value,source_kind,created_at,updated_at) VALUES ('a:c','a:0','x','x','self',0,0)")).toThrow(/NOT NULL/);
  });
});
test('FK проверяет именно текущую беседу при существующем родителе другой', async () => {
  await withParticipantDatabase((_db, f) => {
    f.chat('a:one'); f.chat('a:two');
    f.participant('a:one', 'a:u'); f.profile('a:one', 'a:u');
    expect(() => f.profile('a:two', 'a:u')).toThrow(/FOREIGN KEY/);
    f.participant('a:two', 'a:u');
    expect(() => f.fact('a:two', 'a:u')).toThrow(/FOREIGN KEY/);
    expect(() => f.participant('a:missing', 'a:u')).toThrow(/FOREIGN KEY/);
    expect(() => f.participant('a:one', 'a:u')).toThrow(/UNIQUE/);
    expect(() => f.profile('a:one', 'a:u')).toThrow(/UNIQUE/);
    expect(() => f.participant('a:one', 'a:u2', { chatId: null })).toThrow(/NOT NULL/);
    expect(() => f.profile('a:one', 'a:u', { userId: null })).toThrow(/NOT NULL/);
  });
});
for (const patch of [
  { userId: 'b:u' }, { userId: 'a:' }, { userId: ':u' }, { role: 'botOwner' }, { status: 'online' },
  { role: null }, { status: null }, { joinedAt: -1 }, { lastSeenAt: 0.5 }, { roleObservedAt: 9007199254740992 }, { statusObservedAt: -1 },
]) {
  test(`ограничение участия ${JSON.stringify(patch)}`, async () => {
    await withParticipantDatabase((_db, f) => { f.chat('a:c'); expect(() => f.participant('a:c', 'a:u', patch)).toThrow(); });
  });
}
for (const patch of [
  { fieldKey: '' }, { reliability: 'high' }, { visibility: 'public' }, { reliability: null }, { visibility: null },
  { sourceKind: 'unknown' }, { sourceUserId: 'b:u' }, { sourceUserId: ':u' }, { sourceUserId: 'a:' },
  { sourceKind: 'self', sourceUserId: 'a:other' }, { sourceMessageId: '' }, { createdAt: -1 }, { updatedAt: 0.5 },
  { createdAt: 2, updatedAt: 1 }, { userId: null }, { chatId: null },
]) {
  test(`ограничение факта ${JSON.stringify(patch)}`, async () => {
    await withParticipantDatabase((_db, f) => {
      f.chat('a:c'); f.participant('a:c', 'a:u'); f.profile('a:c', 'a:u');
      expect(() => f.fact('a:c', 'a:u', patch)).toThrow();
    });
  });
}
test('профиль проверяет время и запрещены каскадные изменения родителей', async () => {
  await withParticipantDatabase((db, f) => {
    f.chat('a:c'); f.participant('a:c', 'a:u');
    expect(() => f.profile('a:c', 'a:u', { createdAt: 2, updatedAt: 1 })).toThrow(/CHECK/);
    f.profile('a:c', 'a:u'); f.fact('a:c', 'a:u');
    for (const sql of [
      "DELETE FROM chats WHERE chat_id='a:c'", "DELETE FROM chat_participants WHERE chat_id='a:c' AND user_id='a:u'",
      "DELETE FROM participant_profiles WHERE chat_id='a:c' AND user_id='a:u'",
      "UPDATE chats SET chat_id='a:other' WHERE chat_id='a:c'",
      "UPDATE chat_participants SET user_id='a:other' WHERE chat_id='a:c' AND user_id='a:u'",
      "UPDATE participant_profiles SET user_id='a:other' WHERE chat_id='a:c' AND user_id='a:u'",
    ]) expect(() => db.exec(sql)).toThrow(/FOREIGN KEY/);
    expect(f.facts('a:c', 'a:u')).toHaveLength(1);
  });
});
