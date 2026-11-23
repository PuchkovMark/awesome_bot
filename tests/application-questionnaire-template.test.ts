import { expect, test } from 'vitest';
import { legacyQuestionnaire } from '../src/core/questionnaires/legacy-template';
import { chatControlStore } from '../src/storage/chat-control-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { questionnaireStore } from '../src/storage/questionnaire-store';
import { chat, fixture, peer, until } from './helpers/application-response-fixture';
import { seedBeforeQuestionnaires } from './helpers/questionnaire-upgrade';

type App = Awaited<ReturnType<typeof fixture>>;
const owner = 73;
const admin = 41;
const member = 42;
const instructions = 'полным списком, по одному вопросу на строку.';
const chunkHint = '\n\nДля правки дождитесь сообщения редактора.';
const saved = 'Анкета сохранена. Количество вопросов — ';
const reopen = 'Откройте /вопросы и ответьте на сообщение редактора полным списком.';
const original = legacyQuestionnaire.questions.map(({ text }) => text);
const current = (app: App) => questionnaireStore(app.storage).current(app.scope);
const questions = (app: App) => current(app)?.questions.map(({ text }) => text);

function opened(app: App, start: number, destination = peer) {
  return app.sends
    .slice(start)
    .find(({ text, peer_id }) => peer_id === destination && text.endsWith(instructions));
}

async function editor(app: App, actor = owner, destination = peer) {
  const start = app.sends.length;
  app.submit('/вопросы', actor, undefined, destination);
  await until(() => {
    const prompt = opened(app, start, destination);
    expect(prompt).toBeDefined();
    expect(
      app.db
        .prepare('SELECT count(*) FROM questionnaire_editor_prompts WHERE chat_id=? AND receipt=?')
        .pluck()
        .get(`vk:${destination}`, String(prompt?.conversation_message_id)),
    ).toBe(1);
  });
  return opened(app, start, destination)!;
}

test('новая группа сразу получает 16 вопросов, включённое приветствие остаётся самостоятельным', async () => {
  const app = await fixture({ greetings: { members: [owner] } });
  try {
    expect(questions(app)).toEqual(original);
    expect(app.sends).toEqual([]);
    await until(() =>
      expect(participantRegistryStore(app.storage).read(app.scope).lastAttemptComplete).toBe(true),
    );
    const prompt = await editor(app);
    expect(prompt.text).toBe(
      'Вопросы анкеты\n\n' +
        original.join('\n') +
        '\n\nЧтобы изменить анкету, ответьте на это сообщение ' +
        instructions,
    );
    expect(prompt.disableMentions).toBe(1);
    app.submit('/приветствие вкл', owner);
    app.submit('/приглашение вкл', owner);
    await until(() => {
      const controls = chatControlStore(app.storage).read(app.scope);
      expect(controls.greetingEnabledAt).not.toBeNull();
      expect(controls.invitationEnabledAt).not.toBeNull();
    });
    await until(() =>
      expect(app.sends.some(({ text }) => text === 'Приглашения к анкете включены.')).toBe(true),
    );
    const beforeJoin = app.sends.length;
    app.at(1000);
    app.setMembers([owner, admin]);
    app.membership('chat_invite_user_by_link', admin);
    await until(() =>
      expect(app.db.prepare('SELECT count(*) FROM greeting_windows').pluck().get()).toBe(1),
    );
    app.at(31000);
    await until(() =>
      expect(app.db.prepare('SELECT state,invitation_state FROM greeting_windows').get()).toEqual({
        state: 'delivered',
        invitation_state: 'skipped',
      }),
    );
    expect(app.sends.slice(beforeJoin).map(({ text }) => text)).toEqual([
      'Привет, Тест! Добро пожаловать в беседу!',
    ]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('в прежней группе просмотр оставляет образец, редактор меняет состав, права и порядок действуют после перезапуска', async () => {
  const app = await fixture({ existingChat: (path) => seedBeforeQuestionnaires(path, [chat]) });
  try {
    expect(current(app)).toBeNull();
    const ownerPrompt = await editor(app);
    expect(ownerPrompt.text).toContain('Список этой беседы пока не сохранён.');
    expect(ownerPrompt.text).toContain('Сколько в ВРН?');
    expect(current(app)).toBeNull();
    const unauthorized = app.submit('/вопросы', member);
    await app.journaled(unauthorized);
    app.submit('/вопросы', owner, undefined, owner);

    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    const adminPrompt = await editor(app, admin);
    await app.storage.authorization.transaction(app.scope, (tx) => tx.remove('vk:41', false));
    await app.journaled(app.submit('Правка после отзыва', admin, adminPrompt));
    await app.journaled(app.submit('Ответ обычного участника', member, ownerPrompt));
    await app.journaled(app.submit('Ответ на пересылку', owner, ownerPrompt, peer, true));
    expect(current(app)).toBeNull();
    app.submit(' \n', owner, ownerPrompt);
    await until(() =>
      expect(
        app.sends.some((row) => row.text.startsWith('В списке должен быть хотя бы один вопрос.')),
      ).toBe(true),
    );
    expect(current(app)).toBeNull();

    const rewritten = [
      original[15]!,
      'Как к тебе обращаться в этой беседе?',
      ...original.slice(2, 15),
      '/выключить-бота — что значит эта команда? [club314|Пенёк]',
    ];
    const ack = saved + rewritten.length + '.';
    const event = app.submit(rewritten.join('\n'), owner, ownerPrompt);
    await until(() => expect(app.sends.some(({ text }) => text === ack)).toBe(true));
    const first = current(app)!;
    expect(questions(app)).toEqual(rewritten);
    expect(first.questions.every(({ skippable }) => skippable)).toBe(true);
    expect(chatControlStore(app.storage).read(app.scope).enabled).toBe(true);
    await app.restart(true);
    app.replay(event);
    const selected = await editor(app);
    expect(selected.text).toContain(rewritten.join('\n'));
    expect(current(app)).toEqual(first);
    app.submit('Новая редакция?', owner, selected);
    await until(() => expect(questions(app)).toEqual(['Новая редакция?']));
    expect(questionnaireStore(app.storage).get(app.scope, first.ref)).toEqual(first);
    const neighbor = await app.connectGroup(peer + 1);
    expect(questionnaireStore(app.storage).current(neighbor)?.questions).toEqual(
      legacyQuestionnaire.questions,
    );
    expect(app.sends.some(({ peer_id }) => peer_id === owner)).toBe(false);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('длинный список полностью показывается до редактора, частичные и неподтверждённые ответы сохраняют прежнюю редакцию', async () => {
  const app = await fixture();
  try {
    const first = await editor(app);
    const long = 'я'.repeat(1400) + '?\n' + '🙂'.repeat(290) + '?';
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(4000);
    app.submit(long, owner, first);
    await until(() => expect(app.sends.some(({ text }) => text === saved + '2.')).toBe(true));
    const version = current(app)!;

    let from = app.sends.length;
    app.failSend((text) => (text.endsWith(chunkHint) ? 'unknownAfterDelivery' : undefined));
    app.submit('/вопросы', owner);
    await until(() =>
      expect(app.sends.slice(from).some(({ text }) => text.endsWith(chunkHint))).toBe(true),
    );
    const incomplete = app.sends.slice(from).find(({ text }) => text.endsWith(chunkHint))!;
    app.failSend(undefined);
    app.submit('Порция вопросов', owner, incomplete);
    await until(() => expect(app.sends.slice(from).some(({ text }) => text === reopen)).toBe(true));
    expect(opened(app, from)).toBeUndefined();
    expect(current(app)).toEqual(version);

    from = app.sends.length;
    app.failSend((text) =>
      text.startsWith('Редактор анкеты\n') ? 'unknownAfterDelivery' : undefined,
    );
    app.submit('/вопросы', owner);
    await until(() => expect(opened(app, from)).toBeDefined());
    app.failSend(undefined);
    const unknown = opened(app, from)!;
    app.submit('/выключить-бота', owner, unknown);
    await until(() => expect(app.sends.slice(from).some(({ text }) => text === reopen)).toBe(true));
    expect(current(app)).toEqual(version);
    expect(chatControlStore(app.storage).read(app.scope).enabled).toBe(true);

    from = app.sends.length;
    const final = await editor(app);
    const chunks = app.sends.slice(from, app.sends.indexOf(final));
    expect(chunks).toHaveLength(2);
    expect(chunks.every(({ text }) => Buffer.byteLength(text) <= 4000)).toBe(true);
    expect(
      chunks.map(({ text }) => text.slice('Вопросы анкеты\n\n'.length, -chunkHint.length)).join(''),
    ).toBe(long);
    app.submit(chunks[0]!.text, owner, final);
    await until(() => expect(app.sends.slice(from).some(({ text }) => text === reopen)).toBe(true));
    expect(current(app)).toEqual(version);
    app.submit('🤍'.repeat(1001), owner, final);
    await until(() =>
      expect(app.sends.slice(from).some(({ text }) => text.includes('4000 байт UTF-8'))).toBe(true),
    );
    expect(current(app)).toEqual(version);
    app.submit('Новый полный список', owner, final);
    await until(() => expect(questions(app)).toEqual(['Новый полный список']));
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
