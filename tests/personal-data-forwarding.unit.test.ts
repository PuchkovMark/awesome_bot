import { expect, test, vi } from 'vitest';
import { createPersonalCommands } from '../src/app/personal-data';
import type { ConnectionScope } from '../src/contracts/index';

type Options = Parameters<typeof createPersonalCommands>[0];
const peer = 2_000_000_041;
const source = { chatId: `vk:${peer}`, generation: 1 } as unknown as ConnectionScope;
const recipient = 'vk:41';
const hint = 'Отправьте команду отдельным сообщением без пересылки';

function fixture() {
  const privacy = {
    hasData: vi.fn(),
    status: vi.fn(),
    beginExport: vi.fn(),
    export: vi.fn(),
    disable: vi.fn(),
    requestDeletion: vi.fn(),
  };
  const lifecycle = {
    admissionScope: vi.fn<Options['lifecycle']['admissionScope']>(() => source),
    isAdmissionCurrent: vi.fn(() => true),
  };
  const onboarding = { configuredForProfiles: vi.fn(() => true) };
  const channel = {
    replyGroupControl: vi.fn<Options['channel']['replyGroupControl']>(async () => {}),
    replyPrivateControl: vi.fn<Options['channel']['replyPrivateControl']>(async () => {}),
    privateControlDelivery: vi.fn<Options['channel']['privateControlDelivery']>(
      async () => 'delivered',
    ),
    sendPersonalFile: vi.fn<Options['channel']['sendPersonalFile']>(async () => true),
  };
  const execute = createPersonalCommands({
    ownerId: 'vk:73',
    storage: {} as Options['storage'],
    authorization: {} as Options['authorization'],
    privacy: privacy as unknown as Options['privacy'],
    channel,
    lifecycle: lifecycle as unknown as Options['lifecycle'],
    onboarding: onboarding as unknown as Options['onboarding'],
    signal: new AbortController().signal,
    track: vi.fn(),
  });
  return { execute, privacy, channel, lifecycle, onboarding };
}

test.each([peer, 41])(
  'подсказка в диалоге %i предшествует выбору указанной беседы и чтению данных',
  async (destination) => {
    const app = fixture();
    const inGroup = destination === peer;
    const reply = inGroup ? app.channel.replyGroupControl : app.channel.replyPrivateControl;
    const otherReply = inGroup ? app.channel.replyPrivateControl : app.channel.replyGroupControl;
    const commands = [
      '/мои-данные',
      '/отключить-профиль',
      '/удалить-мои-данные',
      '/статус-удаления',
    ];
    let current = true;
    for (const [index, command] of commands.entries()) {
      await app.execute(
        {
          peerId: destination,
          authorId: 41,
          text: `${command} vk:2000000042`,
          cmid: index + 1,
          reply: undefined,
          hasForwarded: true,
        },
        () => current,
      );
    }
    expect(reply.mock.calls.map(([address, text]) => [address, text])).toEqual(
      commands.map(() => [inGroup ? source : recipient, hint]),
    );
    expect(app.lifecycle.admissionScope.mock.calls).toEqual(
      inGroup ? commands.map(() => [source.chatId]) : [],
    );
    const guard = reply.mock.calls[0]![2];
    expect(await guard.allow()).toBe(true);
    current = false;
    expect(guard.isCurrent()).toBe(false);
    expect(await guard.allow()).toBe(false);
    expect(otherReply).not.toHaveBeenCalled();
    for (const operation of Object.values(app.privacy)) expect(operation).not.toHaveBeenCalled();
    expect(app.channel.privateControlDelivery).not.toHaveBeenCalled();
    expect(app.channel.sendPersonalFile).not.toHaveBeenCalled();
    expect(app.onboarding.configuredForProfiles).not.toHaveBeenCalled();
  },
);

test.each([peer, 41])(
  'устаревший вход в диалоге %i завершает обработку до подсказки',
  async (destination) => {
    const app = fixture();
    await app.execute(
      {
        peerId: destination,
        authorId: 41,
        text: '/отключить-профиль',
        cmid: 1,
        reply: undefined,
        hasForwarded: true,
      },
      () => false,
    );
    expect(app.channel.replyGroupControl).not.toHaveBeenCalled();
    expect(app.channel.replyPrivateControl).not.toHaveBeenCalled();
    expect(app.lifecycle.admissionScope).not.toHaveBeenCalled();
  },
);
