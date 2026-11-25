import { expect, test } from 'vitest';
import { chat, fixture, group, ownerId, peer, until } from './helpers/application-response-fixture';

const otherPeer = peer + 1;
const otherChat = `vk:${otherPeer}`;
const owner = 73;
const administrator = 53;
const participant = 41;
const vkAdministrator = 54;
const protectedAdmin = 57;
const label = 'Команда управления администраторами бота';

type App = Awaited<ReturnType<typeof fixture>>;

function bases(app: App, user: number, target: string = chat) {
  return app.db
    .prepare('SELECT basis FROM bot_admin_grants WHERE chat_id=? AND user_id=? ORDER BY basis')
    .pluck()
    .all(target, `vk:${user}`);
}

async function seed(app: App) {
  app.setMembers([owner, administrator, participant, vkAdministrator, protectedAdmin]);
  await app.storage.authorization.transaction(app.scope, (tx) => {
    tx.grant({
      userId: `vk:${administrator}`,
      basis: 'explicit',
      grantedAt: 1,
      grantedBy: ownerId,
    });
    tx.grant({ userId: `vk:${protectedAdmin}`, basis: 'creator', grantedAt: 1, grantedBy: null });
  });
}

function parent(id: number, from: number, destination: number = peer) {
  return {
    peer_id: destination,
    conversation_message_id: id,
    from_id: from,
    date: Math.floor(Date.now() / 1000),
    text: 'Обычная реплика',
  };
}

function receipt(app: App, text: string, to: number = peer) {
  return until(() =>
    expect(app.sends).toContainEqual(
      expect.objectContaining({
        peer_id: to,
        text: expect.stringContaining(text),
      }),
    ),
  );
}

test('обычное назначение по ответу и по ID даёт права только в своей беседе', async () => {
  const app = await fixture();
  try {
    await seed(app);
    await app.connectGroup(otherPeer);
    const input = app.submit('Обычная реплика', participant);
    app.submit('/назначить-админа', administrator, parent(input, participant));
    await receipt(
      app,
      `${chat}@${app.scope.generation} · vk:${participant}\nОбычное назначение выдано.`,
    );
    expect(bases(app, participant)).toEqual(['explicit']);
    expect(bases(app, participant, otherChat)).toEqual([]);
    app.submit('/настройки', participant);
    await receipt(app, 'Тихие часы выключены.');
    const before = app.sends.length;
    const denied = app.submit('/настройки', participant, undefined, otherPeer);
    const after = app.submit('Маркер в соседней беседе', participant, undefined, otherPeer);
    const logged = app.db
      .prepare('SELECT text FROM messages WHERE chat_id=? AND platform_message_id=?')
      .pluck();
    await until(() =>
      expect(logged.get(otherChat, String(after))).toBe('Маркер в соседней беседе'),
    );
    expect(logged.get(otherChat, String(denied))).toBe('/настройки');
    expect(app.sends.slice(before)).toEqual([]);

    app.submit(`/снять-админа vk:${participant}`, participant);
    await receipt(app, `vk:${participant}\nОбычное назначение снято.`);
    expect(bases(app, participant)).toEqual([]);
    app.submit(`/назначить-админа vk:${participant}`, administrator);
    await until(() =>
      expect(
        app.sends.filter((row) => row.text.includes('Обычное назначение выдано.')),
      ).toHaveLength(2),
    );
    expect(bases(app, participant)).toEqual(['explicit']);
    const target = app.submit('Обычная реплика', participant);
    const remove = app.submit('/снять-админа', administrator, parent(target, participant));
    await until(() =>
      expect(
        app.sends.filter((row) => row.text.includes('Обычное назначение снято.')),
      ).toHaveLength(2),
    );
    expect(logged.get(chat, String(remove))).toBe(label);
    expect(bases(app, participant)).toEqual([]);
    expect(bases(app, participant, otherChat)).toEqual([]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('права VK, чужой или неподтверждённый reply и неверный адрес не дают назначение', async () => {
  const app = await fixture({ vkAdmins: [vkAdministrator] });
  try {
    await seed(app);
    const neighbor = await app.connectGroup(otherPeer);
    const missing = app.submit('Обычная реплика', participant);
    app.hideVkMessage(missing);
    const another = app.submit('Обычная реплика', participant, undefined, otherPeer);
    app.submit('/назначить-админа', administrator, parent(missing, participant));
    app.submit('/назначить-админа', administrator, parent(another, participant, otherPeer));
    app.submit(
      `/назначить-админа ${otherChat}@${neighbor.generation} vk:${participant}`,
      administrator,
    );
    app.submit('/назначить-админа vk:99', administrator);
    app.submit(`/назначить-админа vk:${participant}`, vkAdministrator);
    app.submit(`/назначить-админа vk:${participant}`, participant);
    app.submit(`/снять-админа vk:${protectedAdmin}`, administrator);
    await receipt(app, 'Отозвать его может владелец бота из лички.');
    expect(
      app.sends.filter((row) => row.text.includes('Ответьте командой на сообщение')),
    ).toHaveLength(3);
    await receipt(app, 'Не удалось подтвердить участие человека');
    expect(app.sends.filter((row) => row.text.includes('Обычное назначение выдано.'))).toEqual([]);
    expect(bases(app, protectedAdmin)).toEqual(['creator']);
    expect(bases(app, participant)).toEqual([]);
    expect(bases(app, participant, otherChat)).toEqual([]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('отзыв полномочий во время проверки состава и разрыв перед отправкой защищают изменение и подтверждение', async () => {
  const membership = Promise.withResolvers<void>();
  const membershipEntered = Promise.withResolvers<void>();
  const send = Promise.withResolvers<void>();
  const sendEntered = Promise.withResolvers<void>();
  let checking = false;
  let publishing = false;
  const app = await fixture({
    async beforeVkRequest(method, parameters) {
      if (
        checking &&
        method === 'messages.getConversationMembers' &&
        parameters.peer_id === peer &&
        parameters.member_ids === `-${group},${participant}`
      ) {
        membershipEntered.resolve();
        await membership.promise;
      }
      if (
        publishing &&
        method === 'messages.send' &&
        String(parameters.message).includes('Обычное назначение выдано.')
      ) {
        sendEntered.resolve();
        await send.promise;
      }
    },
  });
  try {
    await seed(app);
    checking = true;
    app.submit(`/назначить-админа vk:${participant}`, administrator);
    await membershipEntered.promise;
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.remove(`vk:${administrator}`, false),
    );
    checking = false;
    membership.resolve();
    await app.journaled(app.submit('Маркер после проверки'));
    expect(bases(app, participant)).toEqual([]);
    publishing = true;
    app.submit(`/назначить-админа vk:${participant}`, owner);
    await sendEntered.promise;
    expect(bases(app, participant)).toEqual(['explicit']);
    await app.loseObservation();
    send.resolve();
  } finally {
    membership.resolve();
    send.resolve();
    await app.close();
  }
  expect(app.sends).not.toContainEqual(
    expect.objectContaining({
      text: expect.stringContaining('Обычное назначение выдано.'),
    }),
  );
});

test('личные команды владельца выбирают поколение, отзывают все основания и выдают причину только в личке', async () => {
  const logs: unknown[] = [];
  const app = await fixture({
    logger: {
      event: (event) => {
        logs.push(event);
      },
      componentError: (error) => {
        logs.push(error);
      },
      debugError() {},
      debugText: (entry) => {
        logs.push(entry);
      },
    },
  });
  const reason = 'Синтетическая причина 🐈\nВторая строка';
  const user = `vk:${protectedAdmin}` as const;
  const target = `${chat}@${app.scope.generation}`;
  const audit = app.db
    .prepare('SELECT reason FROM bot_admin_revocation_audit WHERE chat_id=? AND user_id=?')
    .pluck();
  try {
    await seed(app);
    const other = await app.connectGroup(otherPeer);
    for (const scope of [app.scope, other]) {
      await app.storage.authorization.transaction(scope, (tx) =>
        tx.grant({ userId: user, basis: 'explicit', grantedAt: 1, grantedBy: ownerId }),
      );
    }
    const malformedGroup = app.submit(`/отозвать-админа ${target} ${user} ${reason}`, owner);
    await app.journaled(malformedGroup);
    expect(bases(app, protectedAdmin)).toEqual(['creator', 'explicit']);
    expect(audit.get(chat, user)).toBeUndefined();

    const ownerScope = app.db.prepare('SELECT 1 FROM chat_connections WHERE chat_id=?');
    expect(ownerScope.get(ownerId)).toBeUndefined();
    app.submit(`/выключить-бота ${target}`, owner, undefined, owner);
    await receipt(app, 'Бот выключен.', owner);
    app.submit(`/назначить-админа ${target} vk:${participant}`, owner, undefined, owner);
    await receipt(app, `${target} · vk:${participant}\nОбычное назначение выдано.`, owner);
    expect(bases(app, participant)).toEqual(['explicit']);
    app.submit(`/снять-админа ${target} vk:${participant}`, owner, undefined, owner);
    await receipt(app, `${target} · vk:${participant}\nОбычное назначение снято.`, owner);
    expect(bases(app, participant)).toEqual([]);

    app.submit(`/отозвать-админа ${target} ${user} ${reason}`, participant, undefined, participant);
    app.submit(`/отозвать-админа ${target} ${user} ${reason}`, owner, undefined, owner, true);
    expect(audit.get(chat, user)).toBeUndefined();
    app.submit(`/отозвать-админа ${target} ${user} ${reason}`, owner, undefined, owner);
    await receipt(app, 'Все локальные основания отозваны. Аудит сохранён.', owner);
    expect(bases(app, protectedAdmin)).toEqual([]);
    expect(bases(app, protectedAdmin, otherChat)).toEqual(['explicit']);
    expect(audit.get(chat, user)).toBe(reason);
    await app.storage.authorization.transaction(app.scope, (tx) =>
      expect(tx.isRevoked(user)).toBe(true),
    );
    app.submit(`/назначить-админа ${target} ${user}`, owner, undefined, owner);
    await receipt(app, 'Для человека действует отзыв владельца.', owner);
    app.submit(`/аудит-админа ${target} ${user}`, owner, undefined, owner);
    await receipt(app, reason, owner);
    expect(app.sends.filter((row) => row.text.includes(reason)).map((row) => row.peer_id)).toEqual([
      owner,
    ]);
    app.submit(`/отменить-отзыв ${target} ${user}`, owner, undefined, owner);
    await receipt(app, 'Отзыв отменён.', owner);
    expect(audit.get(chat, user)).toBeUndefined();
    expect(bases(app, protectedAdmin)).toEqual([]);
    app.submit(`/назначить-админа ${target} ${user}`, owner, undefined, owner);
    await receipt(app, `${target} · ${user}\nОбычное назначение выдано.`, owner);
    expect(bases(app, protectedAdmin)).toEqual(['explicit']);
    expect(ownerScope.get(ownerId)).toBeUndefined();
    expect(
      app.db
        .prepare('SELECT text FROM messages WHERE chat_id=? AND platform_message_id=?')
        .pluck()
        .get(chat, String(malformedGroup)),
    ).toBe(label);
    expect(JSON.stringify(app.db.prepare('SELECT text FROM messages').pluck().all())).not.toContain(
      'Синтетическая причина',
    );
    expect(JSON.stringify(logs)).not.toContain('Синтетическая причина');
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('личный вход отклоняет неверное поколение, паузу и недопустимую причину', async () => {
  const app = await fixture();
  const user = `vk:${protectedAdmin}`;
  const target = `${chat}@${app.scope.generation}`;
  const original = app.db
    .prepare('SELECT reason FROM bot_admin_revocation_audit WHERE user_id=?')
    .pluck();
  try {
    await seed(app);
    app.submit(
      `/отозвать-админа ${chat}@${app.scope.generation + 1} ${user} Синтетика`,
      owner,
      undefined,
      owner,
    );
    await receipt(app, 'Беседа или поколение недоступны.', owner);
    app.submit(`/отозвать-админа ${target} ${user}  \n  `, owner, undefined, owner);
    await receipt(app, 'Укажите непустую причину отзыва', owner);
    app.submit(`/отозвать-админа ${target} ${user} ${'🐈'.repeat(501)}`, owner, undefined, owner);
    await receipt(app, 'Причина превышает предел в 500 символов.', owner);
    await app.loseObservation();
    app.submit(`/отозвать-админа ${target} ${user} Синтетика`, owner, undefined, owner);
    await until(() =>
      expect(
        app.sends.filter(
          (row) => row.peer_id === owner && row.text.includes('Беседа или поколение недоступны.'),
        ),
      ).toHaveLength(2),
    );
    expect(bases(app, protectedAdmin)).toEqual(['creator']);
    expect(original.get(user)).toBeUndefined();
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test.each(['отмена', 'истечение срока'])(
  'перед отправкой аудита проверяется %s причины',
  async (interruption) => {
    const hold = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const reason = 'Чувствительная синтетическая причина';
    const app = await fixture({
      active: true,
      async beforeVkRequest(method, params) {
        if (method === 'messages.send' && String(params.message).includes(reason)) {
          entered.resolve();
          await hold.promise;
        }
      },
    });
    try {
      await seed(app);
      const target = `${chat}@${app.scope.generation} vk:${protectedAdmin}`;
      app.submit(`/отозвать-админа ${target} ${reason}`, owner, undefined, owner);
      await receipt(app, 'Все локальные основания отозваны.', owner);
      app.submit(`/аудит-админа ${target}`, owner, undefined, owner);
      await entered.promise;
      if (interruption === 'отмена') {
        app.submit(`/отменить-отзыв ${target}`, owner, undefined, owner);
        await receipt(app, 'Отзыв отменён.', owner);
      } else {
        app.at(90 * 86_400_000);
      }
      hold.resolve();
      app.submit(`/аудит-админа ${target}`, owner, undefined, owner);
      await receipt(
        app,
        interruption === 'отмена'
          ? 'Аудита отзыва для этого человека в беседе нет.'
          : 'Срок хранения причины истёк.',
        owner,
      );
    } finally {
      hold.resolve();
      await app.close();
    }
    expect(app.sends.some((row) => row.text.includes(reason))).toBe(false);
  },
);

test('совпавший номер из лички и беседы учитывается раздельно после отказа отправки и перезапуска', async () => {
  const app = await fixture();
  const local = 200;
  const target = `${chat}@${app.scope.generation} vk:${participant}`;
  try {
    await seed(app);
    const neighbor = await app.connectGroup(otherPeer);
    await app.storage.authorization.transaction(neighbor, (tx) =>
      tx.grant({
        userId: `vk:${participant}`,
        basis: 'explicit',
        grantedAt: 1,
        grantedBy: ownerId,
      }),
    );
    let failures = 0;
    app.failSend((text) => {
      if (!text.includes('Обычное назначение выдано.')) return;
      failures++;
      return 15;
    });
    app.submit(`/назначить-админа vk:${participant}`, owner, undefined, peer, false, local);
    await until(() => expect(failures).toBe(1));
    expect(bases(app, participant)).toEqual(['explicit']);
    expect(app.sends.some((row) => row.text.includes('Обычное назначение выдано.'))).toBe(false);
    app.failSend(undefined);
    app.submit(`/снять-админа ${target}`, owner, undefined, owner, false, local);
    await receipt(app, 'Обычное назначение снято.', owner);
    expect(bases(app, participant)).toEqual([]);
    const sources = app.db
      .prepare(
        'SELECT source_chat_id FROM chat_control_commands WHERE chat_id=? AND actor_id=? AND message_id=? ORDER BY source_chat_id',
      )
      .pluck();
    expect(sources.all(chat, ownerId, local)).toEqual([chat, ownerId]);
    await app.restart(true, [otherPeer]);
    app.replay(local, peer);
    await app.journaled(app.submit('Маркер после повтора'));
    expect(bases(app, participant)).toEqual([]);
    app.submit(`/назначить-админа vk:${participant}`, owner);
    await receipt(app, 'Обычное назначение выдано.');
    app.replay(local, owner);
    await receipt(app, 'Команда уже обработана.', owner);
    expect(bases(app, participant)).toEqual(['explicit']);
    expect(bases(app, participant, otherChat)).toEqual(['explicit']);
    expect(sources.all(chat, ownerId, local)).toEqual([chat, ownerId]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
