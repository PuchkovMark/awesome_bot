import { expect, test } from 'vitest';
import { scopeFor, openStorage } from './helpers/connection-scope';
import { alice, group, neighbor, profileFixture } from './helpers/profile-fact-fixture';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import {
  profileUpdateIntervalMs,
  profileUpdateStore,
  profileUpdateWaitMs,
} from '../src/storage/profile-update-store';
import { rememberProfileUpdate } from '../src/storage/profile-update-intake';
import type { ConnectionScope } from '../src/contracts/index';

async function enqueue(
  f: Awaited<ReturnType<typeof profileFixture>>,
  scope: ConnectionScope,
  at: number,
  serial: string,
) {
  const id = await f.message(scope, alice, serial, at);
  lifecycleBackend(f.storage).transaction(scope, (db) => rememberProfileUpdate(db, scope, id, at));
  return id;
}

test('готовность считается по старейшей доступной записи, включая перезапуск и тихую беседу', async () => {
  const f = await profileFixture();
  try {
    const first = await f.chat();
    const second = await f.chat(neighbor);
    f.deliver(first);
    f.deliver(second);
    const start = 100_000;
    const store = () => profileUpdateStore(f.storage);
    expect(store().schedule(start)).toEqual([]);
    await enqueue(f, first, 10, 'before-notice');
    const older = await enqueue(f, first, start, 'older');
    const later = await enqueue(f, first, start + 40 * 60_000, 'later');
    await enqueue(f, second, start + 1000, 'independent');
    await f.reopen();
    const scope = scopeFor(f.storage, group);
    expect(store().ready(scope, start + profileUpdateWaitMs - 1000)).toBeNull();
    expect(
      store()
        .ready(scope, start + profileUpdateWaitMs)
        ?.map(({ id }) => id),
    ).toEqual([older, later]);
    expect(
      store()
        .schedule(start + profileUpdateWaitMs)
        .map(({ dueAt }) => dueAt),
    ).toEqual([start + profileUpdateWaitMs, start + profileUpdateWaitMs + 1000]);
    lifecycleBackend(f.storage).transaction(scope, (db) => {
      db.prepare('DELETE FROM messages WHERE id=?').run(older);
    });
    expect(store().ready(scope, start + profileUpdateWaitMs)).toBeNull();
    expect(store().ready(scope, start + profileUpdateWaitMs + 40 * 60_000)?.[0]?.id).toBe(later);
  } finally {
    await f.close();
  }
});

test('десятая реплика запускает порцию, два процесса делят один запуск и выдерживают 5 минут', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const at = 100_000;
    const budget = { group: true, input: 2, output: 1 };
    const store = profileUpdateStore(f.storage);
    const ids: number[] = [];
    for (let i = 0; i < 9; i++) ids.push(await enqueue(f, scope, at + i, 'first-' + i));
    expect(store.ready(scope, at + 8)).toBeNull();
    ids.push(await enqueue(f, scope, at + 9, 'first-9'));
    const second = await openStorage(f.path);
    try {
      const secondScope = scopeFor(second, group);
      expect(store.ready(scope, at + 9)?.map(({ id }) => id)).toEqual(ids);
      expect(
        profileUpdateStore(second)
          .ready(secondScope, at + 9)
          ?.map(({ id }) => id),
      ).toEqual(ids);
      const run = store.begin(scope, ids, at + 9, budget)!;
      expect(run).toBeTruthy();
      expect(profileUpdateStore(second).begin(secondScope, ids, at + 9, budget)).toBeNull();
      const next: number[] = [];
      for (let i = 0; i < 10; i++) next.push(await enqueue(f, scope, at + 10 + i, 'second-' + i));
      expect(store.finish(run, at + 20, true)).toBe(true);
      await f.reopen();
      const reopened = profileUpdateStore(f.storage);
      const current = scopeFor(f.storage, group);
      expect(reopened.ready(current, at + 9 + profileUpdateIntervalMs - 1000)).toBeNull();
      expect(
        reopened.ready(current, at + 9 + profileUpdateIntervalMs)?.map(({ id }) => id),
      ).toEqual(next);
      const nextRun = reopened.begin(current, next, at + 9 + profileUpdateIntervalMs, budget)!;
      expect(nextRun).toBeTruthy();
      expect(
        reopened.finish({ ...run, scope: current }, at + 9 + profileUpdateIntervalMs, true),
      ).toBe(false);
      expect(reopened.finish(nextRun, at + 10 + profileUpdateIntervalMs, true)).toBe(true);
      expect(reopened.schedule(at + 10 + profileUpdateIntervalMs)).toEqual([]);
    } finally {
      await second.close();
    }
  } finally {
    await f.close();
  }
});
