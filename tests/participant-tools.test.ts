import { test, expect } from 'vitest';
import { participantTools, type PublicParticipant } from '../src/tools/participants';
import { authorizationFixture } from './helpers/authorization-fixture';
import { FakeAdapter } from './helpers/fake-adapters';
import { scopeForService } from './helpers/connection-scope';
import { createToolRegistry } from '../src/tools/registry';

test('двенадцать человек, общий предел между инструментами, видимость и повторная проверка', async () => {
  const f = await authorizationFixture();
  try {
    const members: PublicParticipant[] = Array.from({ length: 12 }, (_, i) => ({
      user: `test-a:${i + 1}`,
      name: i < 2 ? 'Саша Иванов' : `Тест ${i}`,
      present: true,
      interests: i === 1 ? ['шахматы'] : [],
      sourceIds: [i + 10],
    }));
    const adapter = new FakeAdapter('test-a'),
      scope = scopeForService(f.service, 'test-a:one'),
      userId = 'test-a:1';
    const session = () => {
      const p = participantTools(
        () => ({ complete: false, members }),
        new Map([
          ['reply', members[1]!.user],
          ['last', members.at(-1)!.user],
        ]),
        () => true,
      );
      return createToolRegistry(
        p.definitions,
        {
          adapter,
          platform: 'test-a',
          chatId: scope.chatId,
          userId,
          isAdmin: false,
          authorization: f.service.context({ scope, userId }),
        },
        () => true,
      );
    };
    const r = session(),
      issued = await r.schemas();
    const run = (name: string, args: unknown) =>
      r.execute({ id: 'x', name, arguments: JSON.stringify(args) }, issued);
    const search = await run('participant_search', { query: 'Саша' });
    expect(JSON.parse(search.text).participants).toHaveLength(2);
    const card = JSON.parse((await run('participant_card', { ref: 'reply' })).text);
    expect(card.participants[0].interests).toEqual(['шахматы']);
    expect(
      JSON.parse((await run('participant_card', { ref: 'Саша Иванов' })).text).clarify,
    ).toBeDefined();
    const page = JSON.parse((await run('participant_list', { limit: 20 })).text);
    expect(page).toMatchObject({ limited: true, incomplete: true });
    expect(page.participants).toHaveLength(10);
    const read = await run('participant_search', { query: 'шахматы' });
    expect(JSON.parse(read.text).participants).toHaveLength(1);
    members[1] = { ...members[1]!, interests: [] };
    expect(read.current!()).toBe(false);
    expect(
      JSON.parse((await run('participant_search', { query: 'шахматы' })).text).participants,
    ).toHaveLength(0);
    const fresh = session();
    expect(
      JSON.parse(
        (
          await fresh.execute(
            { id: 'x', name: 'participant_list', arguments: '{}' },
            await fresh.schemas(),
          )
        ).text,
      ).participants,
    ).toHaveLength(5);
  } finally {
    await f.close();
  }
});
