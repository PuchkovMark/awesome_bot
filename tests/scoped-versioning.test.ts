import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { catalogAdministration } from '../src/storage/catalog-admin';
import { createLifecycleService } from '../src/core/index';
import type { LocalContentKind, VersionInput } from '../src/contracts/versioning';
import { storageFixture } from './helpers/storage-fixture';
test('локальные версии изолированы, системный промпт только общий, все операции требуют scope', async () => {
  const storage = await openStorage(':memory:', {
      versioning: { textMaxLength: 2, maxPerEntity: 2 },
    }),
    a = scopeFor(storage, 'vk:a'),
    b = scopeFor(storage, 'vk:b');
  try {
    const global = await catalogAdministration(storage).append({
      kind: 'system_prompt',
      key: 'p',
      text: 'G',
      createdAt: 0,
      expectedHead: null,
    });
    expect(global.status).toBe('created');
    for (const scope of [a, b]) {
      const result = await storage.versions.append(scope, {
        kind: 'persona',
        key: 'p',
        text: scope === a ? 'A' : 'B',
        createdAt: 0,
        expectedHead: null,
      });
      if (result.status !== 'created') throw Error();
      expect((await storage.versions.get(scope, result.value.ref))!.text).toBe(
        scope === a ? 'A' : 'B',
      );
      if (scope === a) {
        await expect(storage.versions.get(b, result.value.ref)).rejects.toMatchObject({
          code: 'invalid_input',
        });
      }
      await expect(
        storage.versions.append(scope, {
          kind: 'system_prompt' as LocalContentKind,
          key: 'p',
          text: 'X',
          createdAt: 0,
          expectedHead: null,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      expect(
        await storage.versions.append(scope, {
          kind: 'persona',
          key: 'p',
          text: 'X',
          createdAt: 0,
          expectedHead: null,
        }),
      ).toEqual({ status: 'conflict' });
      await storage.versions.append(scope, {
        kind: 'persona',
        key: 'p',
        text: '😀я',
        createdAt: 0,
        expectedHead: 1,
      });
      await expect(
        storage.versions.append(scope, {
          kind: 'persona',
          key: 'p',
          text: 'X',
          createdAt: 0,
          expectedHead: 2,
        }),
      ).rejects.toMatchObject({ code: 'limit_exceeded' });
      await expect(
        storage.versions.append(scope, {
          kind: 'persona',
          key: 'new',
          text: 'private',
          createdAt: 0,
          expectedHead: null,
        }),
      ).rejects.toMatchObject({ code: 'limit_exceeded' });
    }
    const life = createLifecycleService({
      storage,
      ownerId: 'vk:owner',
      source: {
        async observe() {
          return { confidence: 'uncertain', bot: 'unknown' };
        },
      },
    });
    await life.verify('vk:a');
    await expect(storage.versions.systemPrompt(a)).rejects.toMatchObject({
      code: 'uncertain_connection',
    });
    const next = life.decide(life.owner('vk:a', 'vk:owner'), 'new');
    await expect(
      storage.versions.append(a, {
        kind: 'persona',
        key: 'p',
        text: 'X',
        createdAt: 0,
        expectedHead: null,
      }),
    ).rejects.toMatchObject({ code: 'stale_scope' });
    await expect(storage.versions.systemPrompt({ ...next })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  } finally {
    await storage.close();
  }
});
test('снимок getter не меняет вид; понижение лимитов сохраняет чтение', async () => {
  const f = storageFixture();
  let storage = await openStorage(f.path);
  try {
    const scope = scopeFor(storage, 'vk:a');
    let calls = 0;
    const result = await storage.versions.append(scope, {
      get kind() {
        return (++calls === 1 ? 'persona' : 'system_prompt') as LocalContentKind;
      },
      key: 'p',
      text: 'literal',
      createdAt: 0,
      expectedHead: null,
    });
    if (result.status !== 'created') throw Error();
    const old = result.value.ref;
    await storage.close();
    storage = await openStorage(f.path, { versioning: { textMaxLength: 1, maxPerEntity: 1 } });
    const fresh = scopeFor(storage, 'vk:a');
    expect((await storage.versions.get(fresh, old))!.text).toBe('literal');
    await expect(
      storage.versions.append(fresh, {
        kind: 'persona',
        key: 'p',
        text: '',
        createdAt: 0,
        expectedHead: 1,
      }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(
      storage.versions.append(fresh, {
        kind: 'system_prompt',
        key: 'p',
        text: '',
        createdAt: 0,
        expectedHead: null,
      } as unknown as VersionInput<LocalContentKind>),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  } finally {
    await storage.close();
    f.cleanup();
  }
});
