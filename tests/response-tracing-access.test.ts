import { expect, test } from 'vitest';
import { authorizationFixture } from './helpers/authorization-fixture';
import { scopeFor } from './helpers/connection-scope';
import { createTraceDiagnostics } from '../src/core/response-tracing/diagnostics';
test('диагностика проверяет личность, актуальную роль, беседу и выключение в транзакции', async () => {
  const f = await authorizationFixture();
  try {
    const d = createTraceDiagnostics({ storage: f.storage, authorization: f.service });
    expect(await d.last(f.member)).toMatchObject({ allowed: false });
    expect(await d.last({ ...f.owner })).toMatchObject({ allowed: false, code: 'invalid_context' });
    await f.service.grant(
      f.owner,
      'vk:user',
      await f.service.confirmMembership(f.member.scope, 'vk:user'),
    );
    expect(await d.last(f.member)).toEqual({ allowed: true, value: null });
    const other = f.service.context({ scope: scopeFor(f.storage, 'vk:two'), userId: 'vk:user' });
    expect(await d.last(other)).toMatchObject({ allowed: false });
    await f.service.remove(f.owner, 'vk:user');
    expect(await d.last(f.member)).toMatchObject({ allowed: false });
    await f.service.grant(
      f.owner,
      'vk:user',
      await f.service.confirmMembership(f.member.scope, 'vk:user'),
    );
    await f.storage.chats.update(f.member.scope, { enabled: false });
    expect(await d.last(f.member)).toMatchObject({ allowed: false, code: 'disabled' });
    expect(await d.last(f.owner)).toEqual({ allowed: true, value: null });
  } finally {
    await f.close();
  }
});
