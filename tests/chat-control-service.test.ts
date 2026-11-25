import { expect, test } from 'vitest';
import { authorizationFixture } from './helpers/authorization-fixture';
import { scopeFor } from './helpers/connection-scope';
import { chatControlStore } from '../src/storage/chat-control-store';
import { chatControlAction, parseChatControl } from '../src/core/chat-control/commands';
import { routeMessage } from '../src/core/message-router/routing';

const quarter = 15 * 60_000;
const current = () => true;

test('одна пауза на всю беседу, запрет повторного запроса и отдельное продление администратором', async () => {
  let now = 100;
  const f = await authorizationFixture({ now: () => now });
  try {
    const { owner, member, service, storage } = f;
    const other = service.context({ scope: member.scope, userId: 'vk:other' });
    const pause = { kind: 'pause' } as const;
    expect(await service.controlChat(member, pause, current)).toMatchObject({
      allowed: true,
      value: { status: 'inactive' },
    });
    expect(
      await service.controlChat(member, { kind: 'mode', mode: 'active' }, current),
    ).toMatchObject({ allowed: false });
    await service.controlChat(owner, { kind: 'mode', mode: 'active' }, current);
    const concurrent = await Promise.all([
      service.controlChat(member, pause, current),
      service.controlChat(other, pause, current),
    ]);
    expect(concurrent).toMatchObject([
      { allowed: true, value: { status: 'applied', state: { pausedUntil: 100 + quarter } } },
      { allowed: true, value: { status: 'waiting', state: { pausedUntil: 100 + quarter } } },
    ]);
    const store = chatControlStore(storage);
    expect(store.allowsAutonomous(member.scope, now)).toBe(false);
    expect(
      routeMessage({
        settings: { enabled: true, responseMode: 'active' },
        message: {
          kind: 'message',
          chatId: member.chatId,
          userId: member.userId,
          authorName: '',
          text: 'Вопрос',
          timestamp: now,
          messageId: '5',
          attachments: [],
          isGroupChat: true,
          isBot: false,
          isAdmin: false,
          isMentioned: true,
          isReplyToBot: false,
        },
      }),
    ).toMatchObject({ kind: 'ordinary', reason: 'mention' });
    await service.grant(
      owner,
      member.userId,
      await service.confirmMembership(member.scope, member.userId),
    );
    now += 1;
    expect(
      await service.controlChat(member, { kind: 'extend', minutes: 1 }, current),
    ).toMatchObject({
      allowed: true,
      value: {
        status: 'applied',
        state: {
          pausedUntil: 100 + quarter + 60_000,
          nextParticipantPause: 100 + 2 * quarter + 60_000,
        },
      },
    });
    now = 100 + quarter + 60_000;
    expect(store.allowsAutonomous(member.scope, now)).toBe(true);
    expect(await service.controlChat(other, pause, current)).toMatchObject({
      value: { status: 'waiting' },
    });
    now += quarter;
    expect(await service.controlChat(other, pause, current)).toMatchObject({
      value: { status: 'applied' },
    });
    await service.remove(owner, member.userId);
    expect(await service.controlChat(member, { kind: 'disableAutonomous' }, current)).toMatchObject(
      { allowed: false },
    );
    expect(await service.controlChat(owner, { kind: 'disableAutonomous' }, current)).toMatchObject({
      value: { state: { autonomousDisabled: true } },
    });
    expect(store.allowsAutonomous(member.scope, now + 10 * quarter)).toBe(false);
    expect(store.read(scopeFor(storage, 'vk:two')).pausedUntil).toBeNull();
    expect(await service.controlChat({ ...owner }, { kind: 'settings' }, current)).toMatchObject({
      allowed: false,
      code: 'invalid_context',
    });
  } finally {
    await f.close();
  }
});

test('включение доступно владельцу из служебного контекста, повтор команды не возвращает старое состояние', async () => {
  const f = await authorizationFixture();
  try {
    const { owner, member, service, storage } = f;
    const groupOwner = service.context({ scope: owner.scope, userId: owner.userId });
    expect(await service.controlChat(owner, { kind: 'off' }, current, 14)).toMatchObject({
      value: { state: { enabled: false, mode: 'normal' } },
    });
    expect(await service.controlChat(groupOwner, { kind: 'on' }, current)).toMatchObject({
      allowed: false,
      code: 'disabled',
    });
    expect(await service.controlChat(member, { kind: 'settings' }, current)).toMatchObject({
      allowed: false,
      code: 'disabled',
    });
    expect(await service.controlChat(owner, { kind: 'on' }, current, 15)).toMatchObject({
      value: { state: { enabled: true, mode: 'normal' } },
    });
    expect(await service.controlChat(owner, { kind: 'off' }, current, 14)).toMatchObject({
      value: { status: 'duplicate', state: { enabled: true } },
    });
    const freshScope = scopeFor(storage, 'vk:2000000070');
    const freshOwner = service.context({ scope: freshScope, userId: owner.userId, kind: 'owner' });
    expect(await storage.chats.get(freshScope)).toBeNull();
    expect(await service.controlChat(freshOwner, { kind: 'off' }, current, 16)).toMatchObject({
      allowed: true,
      value: { state: { enabled: false, mode: 'normal' } },
    });
    expect(await storage.chats.get(freshScope)).toMatchObject({
      enabled: false,
      responseMode: 'normal',
    });
    expect(parseChatControl('/режим vk:2000000004@7 активный', 'private')).toEqual({
      command: { kind: 'mode', mode: 'active' },
      target: { chatId: 'vk:2000000004', generation: 7 },
    });
    expect(parseChatControl('помолчи, пожалуйста', 'group')).toBeUndefined();
    expect(parseChatControl('/продлить-паузу -1', 'group')).toEqual({
      command: { kind: 'extendHelp' },
    });
  } finally {
    await f.close();
  }
});

test('вопросы анкеты относятся к групповым настройкам знакомства', async () => {
  const f = await authorizationFixture();
  try {
    expect(parseChatControl('/вопросы', 'group')).toEqual({ command: { kind: 'questionnaire' } });
    expect(parseChatControl('/вопросы vk:2000000010@1', 'private')).toEqual({ command: 'invalid' });
    const command = { kind: 'questionnaire' } as const;
    expect(chatControlAction(command)).toMatchObject({
      action: 'chat.onboarding.configure',
      minimumRole: 'admin',
    });
    expect(await f.service.controlChat(f.member, command, current)).toMatchObject({
      allowed: false,
    });
    expect(await f.service.controlChat(f.owner, command, current)).toMatchObject({
      allowed: true,
      value: { state: { greetingEnabledAt: null, invitationEnabledAt: null } },
    });
  } finally {
    await f.close();
  }
});
