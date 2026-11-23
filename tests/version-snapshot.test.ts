import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { catalogAdministration } from '../src/storage/catalog-admin';
import type { ContentVersion, VersionRef, GlobalVersionRef } from '../src/contracts/versioning';
import { storageFixture } from './helpers/storage-fixture';
function coherent(value: ContentVersion | null) {
  expect(value).not.toBeNull();
  expect(value!.text).toBe(value!.ref.version === 1 ? 'A' : 'B');
}
test.each(['local', 'global', 'system'] as const)(
  'согласованный снимок при смене выбора через другое соединение: %s',
  async (area) => {
    const f = storageFixture(),
      one = await openStorage(f.path),
      two = await openStorage(f.path);
    try {
      const s1 = scopeFor(one, 'vk:a'),
        s2 = scopeFor(two, 'vk:a'),
        admin1 = catalogAdministration(one),
        admin2 = catalogAdministration(two);
      const refs: VersionRef[] = [];
      for (const version of [1, 2]) {
        const input = {
          kind: area === 'system' ? ('system_prompt' as const) : ('persona' as const),
          key: 'k',
          text: version === 1 ? 'A' : 'B',
          createdAt: version,
          expectedHead: version === 1 ? null : 1,
        };
        const result =
          area === 'local'
            ? await one.versions.append(s1, { ...input, kind: 'persona' })
            : await admin1.append(input);
        if (result.status !== 'created') throw Error();
        refs.push(result.value.ref);
      }
      const a = refs[0]!,
        b = refs[1]!;
      const choose = (ref: VersionRef, expected: VersionRef | null) =>
        area === 'system'
          ? admin2.selectSystemPrompt(ref as GlobalVersionRef, expected as GlobalVersionRef | null)
          : two.versions.select(s2, 'persona', ref, expected);
      const read = () =>
        area === 'system' ? one.versions.systemPrompt(s1) : one.versions.selected(s1, 'persona');
      await choose(a, null);
      const old = read();
      const change = choose(b, a);
      const snapshot = await old;
      await change;
      coherent(snapshot);
      expect(snapshot!.ref).toEqual(a);
      coherent(await read());
      expect((await read())!.ref).toEqual(b);
      expect(snapshot!.text).toBe('A');
      await choose(a, b);
      const broken = async () => {
        const ref = (await read())!.ref;
        await choose(b, a);
        const text = (await read())!.text;
        return { ref, text, createdAt: 0 };
      };
      // Отрицательный контроль показывает, что смешанный снимок обнаруживается.
      const mixed = await broken();
      expect(() => coherent(mixed)).toThrow();
    } finally {
      await one.close();
      await two.close();
      f.cleanup();
    }
  },
);
