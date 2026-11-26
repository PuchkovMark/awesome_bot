import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createLifecycleService } from '../src/core/index';
import { openStorage } from '../src/storage/index';
import { reminderStore, reminderGraceMs, reminderStatusMs } from '../src/storage/reminder-store';
import { storageFixture } from './helpers/storage-fixture';

const now = Date.parse('2026-11-23T12:00:00Z');
const ownerId = 'vk:99';
const dueAt = now + 60_000;
const fields = {
  text: 'взять документы',
  dueAt,
  timezone: 'Europe/Moscow',
  confirmation: ['Назначено'],
};
const source = { messageId: '1', originAt: now };

function created(assignment: ReturnType<ReturnType<typeof reminderStore>['create']>) {
  if (assignment?.kind !== 'created') throw Error('Ожидалось новое напоминание');
  return assignment.item;
}

async function fixture(storage: Awaited<ReturnType<typeof openStorage>>) {
  const life = createLifecycleService({
    storage,
    ownerId,
    source: {
      async observe() {
        return { confidence: 'confirmed', bot: 'present' };
      },
    },
  });
  for (const id of ['vk:41', 'vk:42', 'vk:2000000041'] as const) {
    try {
      life.current(id);
    } catch {
      await life.verify(id);
    }
  }
  return {
    life,
    one: { userId: 'vk:41', scope: life.admissionScope('vk:41') } as const,
    two: { userId: 'vk:42', scope: life.admissionScope('vk:42') } as const,
    group: life.admissionScope('vk:2000000041'),
    store: reminderStore(storage),
  };
}

test('личные записи, отмена, срок статуса и дедупликация сохраняются при открытии БД', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  try {
    let f = await fixture(storage);
    const input = { scope: f.group, ...source };
    const first = created(f.store.create(f.one, input, fields, now));
    expect(f.store.create(f.one, input, fields, now)).toEqual({ kind: 'existing', item: first });
    const second = created(f.store.create(f.one, { ...input, messageId: '2' }, fields, now));
    expect(second.id).not.toBe(first.id);
    expect(f.store.cancel(f.two, first.id, now)).toBe('missing');
    expect(f.store.list(f.two, now)).toEqual([]);
    expect(f.store.cancel(f.one, first.id, now)).toBe('cancelled');
    await storage.close();

    storage = await openStorage(files.path);
    f = await fixture(storage);
    const currentInput = { scope: f.group, ...source };
    expect(f.store.list(f.one, now)).toEqual([
      expect.objectContaining({ id: first.id, text: null, state: 'cancelled' }),
      expect.objectContaining({ id: second.id, text: fields.text, state: 'pending' }),
    ]);
    expect(f.store.replay(f.one, currentInput, now + reminderStatusMs - 1)?.state).toBe(
      'cancelled',
    );
    expect(f.store.create(f.one, currentInput, fields, now + reminderStatusMs)).toBeNull();
    expect(f.store.list(f.one, now + reminderStatusMs).some(({ id }) => id === first.id)).toBe(
      false,
    );
    f.life.deleteData(f.life.owner(f.one.scope.chatId, ownerId), f.one.scope.generation);
    const fresh = f.life.decide(f.life.owner(f.one.scope.chatId, ownerId), 'new');
    expect(f.store.list({ userId: f.one.userId, scope: fresh }, now + reminderStatusMs)).toEqual(
      [],
    );
  } finally {
    await storage.close();
    files.cleanup();
  }
});

test('черновик закрывается на точной границе и разовая зона остаётся у записи', async () => {
  const storage = await openStorage(':memory:');
  try {
    const f = await fixture(storage);
    const input = { scope: f.one.scope, ...source };
    const draft = created(
      f.store.create(
        f.one,
        input,
        {
          draft: {
            needs: 'zone',
            schedule: { kind: 'local', date: 'завтра', hour: 18, minute: 0 },
          },
          text: fields.text,
        },
        now,
      ),
    );
    expect(f.store.list(f.one, now + reminderGraceMs - 1)[0]?.id).toBe(draft.id);
    expect(f.store.list(f.one, now + reminderGraceMs - 1, 'cancellable')[0]?.id).toBe(draft.id);
    expect(f.store.list(f.one, now + reminderGraceMs, 'cancellable')).toEqual([]);
    expect(
      f.store.revise(f.one, { ...input, messageId: '2' }, draft.id, fields, now + reminderGraceMs),
    ).toBeNull();
    expect(f.store.list(f.one, now + reminderGraceMs)).toEqual([]);
    expect(f.store.create(f.one, input, fields, now + reminderGraceMs)).toBeNull();
    f.store.timezone(f.one, 'UTC');
    const item = created(f.store.create(f.one, { ...input, messageId: '3' }, fields, now));
    expect(item.timezone).toBe('Europe/Moscow');
    expect(f.store.timezone(f.one)).toBe('UTC');
  } finally {
    await storage.close();
  }
});

test('захват конкурирующими исполнителями, отмена и подтверждение частей согласованы', async () => {
  const files = storageFixture();
  const a = await openStorage(files.path),
    b = await openStorage(files.path);
  try {
    const f = await fixture(a),
      rival = reminderStore(b);
    const item = created(f.store.create(f.one, { scope: f.one.scope, ...source }, fields, now));
    const chunks = () => ['Первая', 'Вторая'];
    const lease = f.store.claimDelivery(dueAt, chunks)!;
    expect(rival.claimDelivery(dueAt, chunks)).toBeUndefined();
    const first = f.store.getPart(lease, dueAt)!;
    expect(f.store.list(f.one, dueAt, 'cancellable').map(({ id }) => id)).toEqual([item.id]);
    expect(f.store.beginPart(lease, first, dueAt)).toBe(true);
    expect(f.store.list(f.one, dueAt, 'cancellable')).toEqual([]);
    expect(f.store.cancel(f.one, item.id, dueAt)).toBe('sending');
    f.store.receipt(lease, first, '101');
    expect(f.store.settle(lease, first, 'delivered', dueAt)).toBe(true);
    const second = f.store.getPart(lease, dueAt)!;
    expect(second.send_id).not.toBe(first.send_id);
    expect(f.store.beginPart(lease, second, dueAt)).toBe(true);
    expect(f.store.settle(lease, second, 'unknown', dueAt)).toBe(false);
    expect(f.store.list(f.one, dueAt, 'cancellable')).toEqual([]);
    expect(f.store.cancel(f.one, item.id, dueAt)).toBe('unknown');
    expect(rival.claimDelivery(dueAt + 30_000, chunks)).toBeUndefined();
    expect(f.store.list(f.one, dueAt + reminderGraceMs)[0]?.state).toBe('pending');
    expect(f.store.list(f.one, dueAt + reminderGraceMs + 1)[0]).toMatchObject({
      state: 'unknown',
      text: null,
    });
  } finally {
    await a.close();
    await b.close();
    files.cleanup();
  }
});

test('отказ и неопределённость подтверждения различаются после повторного открытия базы', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  try {
    let f = await fixture(storage);
    const ids = (['failed', 'unknown'] as const).map((outcome, index) => {
      const item = created(
        f.store.create(
          f.one,
          { ...source, scope: f.group, messageId: String(index + 1) },
          { ...fields, scheduleKey: 'relative:1', text: fields.text + ' ' + index },
          now,
        ),
      );
      const lease = f.store.claimConfirmation(f.one, item.id, now)!;
      const part = f.store.getPart(lease, now)!;
      expect(f.store.beginPart(lease, part, now)).toBe(true);
      if (outcome === 'unknown') f.store.receipt(lease, part, '101');
      expect(f.store.settle(lease, part, outcome, now)).toBe(false);
      return item.id;
    });
    await storage.close();
    storage = await openStorage(files.path);
    f = await fixture(storage);
    const db = new Database(files.path, { readonly: true, fileMustExist: true });
    try {
      expect(
        db
          .prepare(
            `SELECT r.id,r.due_at,r.schedule_key,p.state,p.definite_failure,p.receipt
           FROM personal_reminders r JOIN personal_reminder_parts p ON p.reminder_id=r.id
           ORDER BY r.id`,
          )
          .all(),
      ).toEqual([
        {
          id: ids[0],
          due_at: dueAt,
          schedule_key: 'relative:1',
          state: 'ready',
          definite_failure: 1,
          receipt: null,
        },
        {
          id: ids[1],
          due_at: dueAt,
          schedule_key: 'relative:1',
          state: 'unknown',
          definite_failure: 0,
          receipt: '101',
        },
      ]);
      expect(f.store.cancel(f.one, ids[0]!, now)).toBe('cancelled');
      expect(
        db
          .prepare('SELECT text,schedule_key,hint_claimed FROM personal_reminders WHERE id=?')
          .get(ids[0]),
      ).toEqual({ text: null, schedule_key: null, hint_claimed: 0 });
      expect(
        db
          .prepare('SELECT count(*) FROM personal_reminder_parts WHERE reminder_id=?')
          .pluck()
          .get(ids[0]),
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await storage.close();
    files.cleanup();
  }
});

test('новое событие привязывается к первому сроку в общей БД, сохраняются разные сроки и авторы', async () => {
  const files = storageFixture();
  const a = await openStorage(files.path),
    b = await openStorage(files.path);
  try {
    const first = await fixture(a);
    const second = await fixture(b);
    const after = now + 20_000;
    const schedule = { ...fields, scheduleKey: 'relative:1' };
    const item = created(
      first.store.create(first.one, { ...source, scope: first.group }, schedule, now),
    );
    const repeated = { scope: second.one.scope, messageId: '1', originAt: after };
    expect(
      second.store.create(second.one, repeated, { ...schedule, dueAt: after + 60_000 }, after),
    ).toMatchObject({
      kind: 'existing',
      item: { id: item.id, dueAt },
    });
    expect(second.store.replay(second.one, repeated, after)?.id).toBe(item.id);
    expect(second.store.list(second.one, after)).toEqual([item]);
    expect(
      created(
        second.store.create(
          second.one,
          { ...repeated, messageId: '2' },
          { ...fields, scheduleKey: 'relative:5', dueAt: after + 300_000 },
          after,
        ),
      ),
    ).toMatchObject({ dueAt: after + 300_000 });
    expect(
      created(
        second.store.create(second.two, { ...repeated, scope: second.two.scope }, schedule, after),
      ).id,
    ).not.toBe(item.id);
  } finally {
    await a.close();
    await b.close();
    files.cleanup();
  }
});

test('неполное условие старого задания оставляет выбор владельцу и сохраняет привязки прежних событий', async () => {
  const storage = await openStorage(':memory:');
  try {
    const f = await fixture(storage);
    const input = { scope: f.group, ...source };
    const known = { ...fields, scheduleKey: 'relative:1' };
    const modern = created(f.store.create(f.one, input, known, now));
    const legacy = created(f.store.create(f.one, { ...input, messageId: '2' }, fields, now));
    const newEvent = { ...input, messageId: '3' };
    expect(f.store.create(f.one, newEvent, known, now)).toEqual({
      kind: 'choose',
      items: [modern, legacy],
    });
    expect(f.store.create(f.one, input, known, now)).toEqual({ kind: 'existing', item: modern });
    expect(f.store.cancel(f.one, modern.id, now)).toBe('cancelled');
    expect(f.store.create(f.one, newEvent, known, now)).toEqual({
      kind: 'choose',
      items: [legacy],
    });
    expect(f.store.replay(f.one, newEvent, now)).toBeUndefined();
    expect(f.store.list(f.one, now).map(({ id }) => id)).toEqual([modern.id, legacy.id]);
  } finally {
    await storage.close();
  }
});
