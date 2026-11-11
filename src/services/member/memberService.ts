import { prisma } from '../../db/client.js';
import settingsService from '../settings/settingsService.js';

export const MAX_QUESTIONNAIRE_QUESTIONS = 32;
export const MAX_QUESTION_LENGTH = 200;
export const MAX_ANSWER_LENGTH = 500;
export const MAX_QUESTIONNAIRE_RESPONSE_LENGTH = 3500;
export const MEMBER_PROFILES_PAGE_SIZE = 10;

const profileQuestionEmojis: Array<[RegExp, string]> = [
  [/(?:возраст|сколько лет)/iu, '🎂'],
  [/(?:имя|зовут|обращаться|позывн|никнейм)/iu, '🏷️'],
  [/(?:работа|уч[её]б|кем|професс)/iu, '💼'],
  [/(?:семейн|отношен|свидан|половин)/iu, '💛'],
  [/(?:город|врн|жив[её]шь|где)/iu, '📍'],
  [/(?:гуля|отдых|актив)/iu, '🌿'],
  [/(?:кофе|чай)/iu, '☕'],
  [/(?:хобби|увлечен|интерес)/iu, '🎯'],
  [/(?:фильм|сериал|кино)/iu, '🎬'],
  [/(?:песн|музык)/iu, '🎵'],
  [/(?:алкогол)/iu, '🍷'],
  [/(?:mbti|тип личности)/iu, '🧠'],
];
const fallbackProfileEmojis = ['💬', '✨', '🌟'];

function getProfileQuestionEmoji(question: string, index: number): string {
  return (
    profileQuestionEmojis.find(([pattern]) => pattern.test(question))?.[1] ??
    fallbackProfileEmojis[index % fallbackProfileEmojis.length]!
  );
}

function parseProfile(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Не удалось прочитать сохранённую анкету.', { cause: error });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((answer) => typeof answer === 'string')
  ) {
    throw new Error('В сохранённой анкете обнаружен некорректный формат.');
  }
  return parsed as Record<string, string>;
}

function formatProfile(answers: Record<string, string>, updatedAt?: Date | null): string {
  const displayName = Object.entries(answers).find(([question]) =>
    question.toLocaleLowerCase('ru-RU').startsWith('как к тебе обращаться'),
  )?.[1];
  const fields = Object.entries(answers)
    .filter(([, answer]) => answer.trim())
    .map(
      ([question, answer], index) =>
        `${getProfileQuestionEmoji(question, index)} ${question}\n${answer}`,
    );
  return [
    `👤 ${displayName ? `Знакомьтесь, ${displayName}!` : 'Профиль участника'}`,
    ...fields,
    updatedAt ? `🕒 Последнее обновление: ${updatedAt.toLocaleDateString('ru-RU')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatProfileIntroduction(
  answers: Record<string, string>,
  vkDisplayName: string,
  welcomeAlreadySent = false,
): string {
  const displayNameAnswer = Object.entries(answers).find(
    ([question, answer]) =>
      answer.trim() && /(?:как.{0,40}обращат|имя|позывн|никнейм|ник)/iu.test(question),
  )?.[1];
  const displayName = displayNameAnswer?.trim() || vkDisplayName;
  const greeting = welcomeAlreadySent
    ? `Немного информации о ${displayName}:`
    : `О, к нам присоединился ${displayName}! 👋\nНемного информации:`;
  const footer = welcomeAlreadySent ? '' : '\nРады видеть в нашей компании! 😊';
  const maxLength = 3500;
  const lines: string[] = [];
  const omissionText = 'Некоторые ответы опущены, чтобы сообщение было короче.';
  const omissionReserve = `\n${omissionText}`.length;
  let omittedAnswers = false;

  for (const [question, rawAnswer] of Object.entries(answers)) {
    const answer = rawAnswer.trim();
    if (!question.trim() || !answer) continue;
    const label = question.replace(/\s+/gu, ' ').trim();
    const line = `• ${label}: ${answer}`;
    const nextLength = [greeting, ...lines, line, footer].join('\n').length + omissionReserve;
    if (nextLength > maxLength) {
      omittedAnswers = true;
      continue;
    }
    lines.push(line);
  }

  const details = lines.length > 0 ? lines.join('\n') : 'В анкете пока нет заполненных ответов.';
  const omissionNote = omittedAnswers ? `\n${omissionText}` : '';
  return `${greeting}\n${details}${omissionNote}${footer}`;
}

function createQuestionnaireTemplate(questions: string[], answers: Record<string, string>): string {
  return [
    'Заполни пункты и отправь весь список ответом на это сообщение либо добавь обращение «Пенёк» или упоминание бота перед шаблоном. Все ответы необязательны.',
    'Пустой ответ сохраняет прежний вариант; чтобы удалить прежний ответ, укажи «—».',
    ...questions.flatMap((question, index) => [
      `${index + 1}. ${question}`,
      `Ответ: ${answers[question] ?? ''}`,
    ]),
  ].join('\n');
}

function normalizeQuestionText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function matchQuestionnaireHeader(
  line: string,
  questions: string[],
  allowNumberedAnswers = false,
): { index: number; answer?: string } | undefined {
  const header = line.match(/^\s*(?:>\s*)?(?:№\s*)?(\d{1,2})\s*(?:[.)\-:]|\s+)(.*)$/u);
  if (!header) return undefined;
  const numberedIndex = Number(header[1]) - 1;

  const payload = (header[2] ?? '').trim();
  const answer = payload.match(
    /^(?:ответ|отвт|отв(?:ет)?|отве[дт])\s*(?:(?::|\]|\)|-|–|—)\s*){0,2}(.*)$/iu,
  );
  if (answer) {
    return numberedIndex >= 0 && numberedIndex < questions.length
      ? { index: numberedIndex, answer: answer[1] ?? '' }
      : undefined;
  }
  if (!payload) {
    return numberedIndex >= 0 && numberedIndex < questions.length
      ? { index: numberedIndex }
      : undefined;
  }

  const actual = normalizeQuestionText(payload);
  const candidates = questions
    .map((question, index) => {
      const expected = normalizeQuestionText(question);
      const distance = editDistance(expected, actual);
      const allowedDistance = Math.max(2, Math.ceil(expected.length * 0.2));
      const similarity = 1 - distance / Math.max(expected.length, actual.length, 1);
      return { index, distance, allowedDistance, similarity };
    })
    .filter(
      ({ distance, allowedDistance, similarity }) =>
        distance <= allowedDistance && similarity >= 0.72,
    )
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        Number(right.index === numberedIndex) - Number(left.index === numberedIndex),
    );
  const best = candidates[0];
  if (best) return { index: best.index };
  return allowNumberedAnswers && numberedIndex >= 0 && numberedIndex < questions.length
    ? { index: numberedIndex, answer: payload }
    : undefined;
}

function getQuestionnaireAnswer(line: string): string | undefined {
  const answer = line.match(
    /^\s*(?:ответ|отвт|отв(?:ет)?|отве[дт])\s*(?:(?::|\]|\)|-|–|—)\s*){0,2}(.*)$/iu,
  );
  return answer?.[1] ?? (answer ? '' : undefined);
}

function isQuestionnaireControlLine(line: string): boolean {
  return /^\s*(?:\/(?:анкета|профиль|profile)\b|давай познакомимся|заполни пункты|пустой ответ сохраняет|отправь заполненный шаблон|если передумаешь)/iu.test(
    line,
  );
}

function parseQuestionnaireForm(
  text: string,
  questions: string[],
  allowNumberedAnswers = false,
): { values: Map<number, string>; error?: string } {
  const values = new Map<number, string>();
  let currentIndex: number | undefined;
  let currentValue = '';

  const saveCurrent = (): string | undefined => {
    if (currentIndex === undefined) return undefined;
    if (values.has(currentIndex)) return 'В анкете повторяется номер вопроса.';
    values.set(currentIndex, currentValue.trim());
    return undefined;
  };

  for (const line of text.split(/\r?\n/u)) {
    const header = matchQuestionnaireHeader(line, questions, allowNumberedAnswers);
    if (header) {
      const error = saveCurrent();
      if (error) return { values, error };
      currentIndex = header.index;
      currentValue = header.answer ?? '';
      continue;
    }

    if (currentIndex === undefined) {
      continue;
    }
    if (isQuestionnaireControlLine(line)) continue;

    const answer = getQuestionnaireAnswer(line);
    if (answer !== undefined) {
      currentValue = answer;
    } else if (line.trim()) {
      currentValue = currentValue ? `${currentValue}\n${line.trim()}` : line.trim();
    }
  }

  const error = saveCurrent();
  if (error) return { values, error };
  return values.size > 0
    ? { values }
    : { values, error: 'Не найдены номера вопросов в заполненной анкете.' };
}

export function parseQuestionnaireQuestions(value: string): string[] {
  const questions = value
    .split('|')
    .map((question) => question.trim())
    .filter(Boolean);
  if (questions.length === 0 || questions.length > MAX_QUESTIONNAIRE_QUESTIONS) {
    throw new Error(`Укажите от 1 до ${MAX_QUESTIONNAIRE_QUESTIONS} вопросов через |.`);
  }
  if (questions.some((question) => question.length > MAX_QUESTION_LENGTH)) {
    throw new Error(`Каждый вопрос должен быть не длиннее ${MAX_QUESTION_LENGTH} символов.`);
  }
  return questions;
}

export function parseStoredQuestionnaireQuestions(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Не удалось прочитать вопросы анкеты из настроек беседы.', { cause: error });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_QUESTIONNAIRE_QUESTIONS ||
    !parsed.every(
      (question): question is string =>
        typeof question === 'string' &&
        question.trim().length > 0 &&
        question.length <= MAX_QUESTION_LENGTH,
    )
  ) {
    throw new Error('В настройках беседы сохранён некорректный список вопросов анкеты.');
  }
  return parsed;
}

/**
 * Управляет участниками бесед, их профилями, событиями вступления и анкетами.
 */
export class MemberService {
  async recordJoin(conversationId: string, vkUserId: string, eventId: string) {
    if (!eventId.trim()) throw new Error('Для обработки вступления нужен идентификатор события.');
    const settings = await settingsService.getChatSettings(conversationId);
    const existing = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { id: true, lastJoinIntroductionEventId: true },
    });
    const joinedAt = new Date();
    await prisma.conversationMember.upsert({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      create: {
        conversationId,
        vkUserId,
        isPresent: true,
        firstJoinedAt: joinedAt,
        lastJoinedAt: joinedAt,
      },
      update: { isPresent: true, lastJoinedAt: joinedAt, leftAt: null },
    });
    const previousEventId = existing?.lastJoinIntroductionEventId ?? null;
    const claimedEvent =
      previousEventId === eventId
        ? { count: 0 }
        : await prisma.conversationMember.updateMany({
            where: {
              conversationId,
              vkUserId,
              lastJoinIntroductionEventId: previousEventId,
            },
            data: { lastJoinIntroductionEventId: eventId },
          });
    const shouldProcessIntroduction = settings.questionnaireEnabled && claimedEvent.count === 1;
    const profile = shouldProcessIntroduction
      ? await this.getProfileDetails(conversationId, vkUserId)
      : undefined;
    const shouldInviteQuestionnaire = shouldProcessIntroduction && !profile;
    if (shouldInviteQuestionnaire) {
      await prisma.conversationMember.update({
        where: { conversationId_vkUserId: { conversationId, vkUserId } },
        data: { questionnaireInviteSentAt: joinedAt },
      });
    }
    return {
      isReturning: Boolean(existing),
      welcomeEnabled: settings.welcomeEnabled,
      welcomeText: settings.welcomeText,
      questionnaireEnabled: settings.questionnaireEnabled,
      shouldInviteQuestionnaire,
      profileIntroduction: profile?.answers,
    };
  }

  async recordLeave(conversationId: string, vkUserId: string): Promise<void> {
    await settingsService.getChatSettings(conversationId);
    const leftAt = new Date();
    await prisma.conversationMember.upsert({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      create: { conversationId, vkUserId, isPresent: false, leftAt },
      update: { isPresent: false, leftAt },
    });
  }

  async hasActiveQuestionnaire(conversationId: string, vkUserId: string): Promise<boolean> {
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { questionnaireIndex: true },
    });
    return member?.questionnaireIndex !== null && member?.questionnaireIndex !== undefined;
  }

  async shouldHandleQuestionnaireAnswer(
    conversationId: string,
    vkUserId: string,
    text: string,
    isReplyToQuestionnaire = false,
  ): Promise<boolean> {
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { questionnaireIndex: true, questionnaireQuestions: true },
    });
    if (member?.questionnaireIndex === null || member?.questionnaireIndex === undefined) {
      return false;
    }
    if (member.questionnaireIndex !== -1) return true;
    if (!member.questionnaireQuestions) return false;
    const questions = parseStoredQuestionnaireQuestions(member.questionnaireQuestions);
    return text
      .split(/\r?\n/u)
      .some((line) => matchQuestionnaireHeader(line, questions, isReplyToQuestionnaire));
  }

  async startQuestionnaire(
    conversationId: string,
    vkUserId: string,
    replaceExisting = false,
  ): Promise<{ prompt: string; alreadyExists: boolean }> {
    const settings = await settingsService.getChatSettings(conversationId);
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: {
        profile: true,
        profileCompleted: true,
        questionnaireIndex: true,
        questionnaireQuestions: true,
        questionnaireAnswers: true,
      },
    });
    if (member?.questionnaireIndex !== null && member?.questionnaireIndex !== undefined) {
      if (member.questionnaireIndex === -1 && replaceExisting) {
        if (!member.questionnaireQuestions || !member.questionnaireAnswers) {
          throw new Error('Не удалось восстановить незавершённую анкету.');
        }
        return {
          prompt: createQuestionnaireTemplate(
            parseStoredQuestionnaireQuestions(member.questionnaireQuestions),
            parseProfile(member.questionnaireAnswers),
          ),
          alreadyExists: member.profileCompleted,
        };
      }
      throw new Error(
        'Анкета уже заполняется. Ответьте на текущий вопрос или отправьте /profile cancel.',
      );
    }
    if (member?.profileCompleted && !replaceExisting) {
      throw new Error('У вас уже есть анкета. Для изменения используйте /profile edit.');
    }

    const questions = parseStoredQuestionnaireQuestions(settings.questionnaireQuestions);
    const existingAnswers =
      member?.profileCompleted && replaceExisting ? parseProfile(member.profile) : {};
    await prisma.conversationMember.upsert({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      create: {
        conversationId,
        vkUserId,
        isPresent: true,
        questionnaireQuestions: JSON.stringify(questions),
        questionnaireAnswers: JSON.stringify(existingAnswers),
        questionnaireIndex: -1,
      },
      update: {
        isPresent: true,
        questionnaireQuestions: JSON.stringify(questions),
        questionnaireAnswers: JSON.stringify(existingAnswers),
        questionnaireIndex: -1,
      },
    });
    return {
      prompt: createQuestionnaireTemplate(questions, existingAnswers),
      alreadyExists: member?.profileCompleted ?? false,
    };
  }

  async answerQuestionnaire(
    conversationId: string,
    vkUserId: string,
    answer: string,
    isReplyToQuestionnaire = false,
  ): Promise<{ prompt?: string; completed?: string }> {
    const trimmed = answer.trim();
    if (!trimmed) return { prompt: 'Ответ не может быть пустым. Попробуйте ещё раз.' };
    if (trimmed.length > MAX_QUESTIONNAIRE_RESPONSE_LENGTH) {
      return {
        prompt: `Ответ слишком длинный. Максимум — ${MAX_QUESTIONNAIRE_RESPONSE_LENGTH} символов.`,
      };
    }

    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: {
        questionnaireQuestions: true,
        questionnaireAnswers: true,
        questionnaireIndex: true,
        profileCompleted: true,
        profileCreatedAt: true,
      },
    });
    if (
      !member ||
      member.questionnaireIndex === null ||
      member.questionnaireQuestions === null ||
      member.questionnaireAnswers === null
    ) {
      return {};
    }

    const questions = parseStoredQuestionnaireQuestions(member.questionnaireQuestions);
    const index = member.questionnaireIndex;
    if (index === -1) {
      const parsed = parseQuestionnaireForm(trimmed, questions, isReplyToQuestionnaire);
      if (parsed.error) return { prompt: `${parsed.error}\nОтправьте заполненный шаблон ещё раз.` };

      const answers = parseProfile(member.questionnaireAnswers);
      for (const [questionNumber, value] of parsed.values) {
        const question = questions[questionNumber];
        if (!question) continue;
        if (value === '—') {
          delete answers[question];
        } else if (value.trim()) {
          if (value.length > MAX_ANSWER_LENGTH) {
            return {
              prompt: `Ответ на вопрос ${questionNumber + 1} слишком длинный. Максимум — ${MAX_ANSWER_LENGTH} символов.`,
            };
          }
          answers[question] = value.trim();
        }
      }

      const now = new Date();
      await prisma.conversationMember.update({
        where: { conversationId_vkUserId: { conversationId, vkUserId } },
        data: {
          profile: JSON.stringify(answers),
          profileCompleted: true,
          profileCreatedAt: member.profileCreatedAt ?? now,
          profileUpdatedAt: now,
          profileDeleteRequestedAt: null,
          questionnaireAnswers: null,
          questionnaireQuestions: null,
          questionnaireIndex: null,
        },
      });
      return { completed: formatProfile(answers, now) };
    }

    if (index < 0 || index >= questions.length) {
      throw new Error('Анкета содержит недопустимый номер вопроса.');
    }
    if (trimmed.length > MAX_ANSWER_LENGTH) {
      return { prompt: `Ответ слишком длинный. Максимум — ${MAX_ANSWER_LENGTH} символов.` };
    }
    let answers: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(member.questionnaireAnswers);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Stored answers are not an object');
      }
      answers = parsed as Record<string, string>;
    } catch (error) {
      throw new Error('Не удалось прочитать текущие ответы анкеты.', { cause: error });
    }
    answers[questions[index]] = trimmed;

    if (index + 1 < questions.length) {
      await prisma.conversationMember.update({
        where: { conversationId_vkUserId: { conversationId, vkUserId } },
        data: { questionnaireAnswers: JSON.stringify(answers), questionnaireIndex: index + 1 },
      });
      return { prompt: questions[index + 1] };
    }

    await prisma.conversationMember.update({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      data: {
        profile: JSON.stringify(answers),
        profileCompleted: true,
        profileCreatedAt: member.profileCreatedAt ?? new Date(),
        profileUpdatedAt: new Date(),
        profileDeleteRequestedAt: null,
        questionnaireAnswers: null,
        questionnaireQuestions: null,
        questionnaireIndex: null,
      },
    });
    return {
      completed: formatProfile(answers, new Date()),
    };
  }

  async cancelQuestionnaire(conversationId: string, vkUserId: string): Promise<boolean> {
    const result = await prisma.conversationMember.updateMany({
      where: {
        conversationId,
        vkUserId,
        questionnaireIndex: { not: null },
      },
      data: {
        questionnaireAnswers: null,
        questionnaireQuestions: null,
        questionnaireIndex: null,
      },
    });
    return result.count > 0;
  }

  async getProfileDetails(
    conversationId: string,
    vkUserId: string,
  ): Promise<
    | {
        answers: Record<string, string>;
        createdAt: Date | null;
        updatedAt: Date | null;
      }
    | undefined
  > {
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: {
        profile: true,
        profileCompleted: true,
        profileCreatedAt: true,
        profileUpdatedAt: true,
      },
    });
    if (!member?.profileCompleted) return undefined;
    return {
      answers: parseProfile(member.profile),
      createdAt: member.profileCreatedAt,
      updatedAt: member.profileUpdatedAt,
    };
  }

  async getProfile(conversationId: string, vkUserId: string): Promise<string | undefined> {
    const profile = await this.getProfileDetails(conversationId, vkUserId);
    if (!profile) return undefined;
    return formatProfile(profile.answers, profile.updatedAt);
  }

  async listProfiles(conversationId: string, page: number) {
    if (!Number.isInteger(page) || page < 1)
      throw new Error('Номер страницы должен быть больше нуля.');
    const where = { conversationId, profileCompleted: true };
    const total = await prisma.conversationMember.count({ where });
    const pageCount = Math.ceil(total / MEMBER_PROFILES_PAGE_SIZE);
    if (page > pageCount) {
      return { total, page, pageCount, profiles: [] };
    }
    const members = await prisma.conversationMember.findMany({
      where,
      select: {
        vkUserId: true,
        profile: true,
        profileUpdatedAt: true,
      },
      orderBy: { profileUpdatedAt: 'desc' },
      skip: (page - 1) * MEMBER_PROFILES_PAGE_SIZE,
      take: MEMBER_PROFILES_PAGE_SIZE,
    });
    return {
      total,
      page,
      pageCount,
      profiles: members.map(({ vkUserId, profile, profileUpdatedAt }) => ({
        vkUserId,
        answers: parseProfile(profile),
        updatedAt: profileUpdatedAt,
      })),
    };
  }

  async updateProfileAnswer(
    conversationId: string,
    vkUserId: string,
    questionNumber: number,
    answer: string,
  ): Promise<string> {
    const trimmed = answer.trim();
    if (!trimmed) throw new Error('Ответ не может быть пустым.');
    if (trimmed.length > MAX_ANSWER_LENGTH) {
      throw new Error(`Ответ слишком длинный. Максимум — ${MAX_ANSWER_LENGTH} символов.`);
    }
    if (!Number.isInteger(questionNumber) || questionNumber < 1) {
      throw new Error('Номер ответа должен быть положительным целым числом.');
    }
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { profile: true, profileCreatedAt: true },
    });
    if (!member) throw new Error('Анкета участника не найдена.');

    const answers = parseProfile(member.profile);
    const questions = Object.keys(answers);
    if (questionNumber > questions.length) {
      throw new Error(`Укажите номер ответа от 1 до ${questions.length}.`);
    }
    answers[questions[questionNumber - 1]] = trimmed;
    const now = new Date();
    await prisma.conversationMember.update({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      data: {
        profile: JSON.stringify(answers),
        profileCompleted: true,
        profileCreatedAt: member.profileCreatedAt ?? now,
        profileUpdatedAt: now,
      },
    });
    return formatProfile(answers, now);
  }

  async clearProfileAnswer(
    conversationId: string,
    vkUserId: string,
    questionNumber: number,
  ): Promise<string> {
    if (!Number.isInteger(questionNumber) || questionNumber < 1) {
      throw new Error('Номер ответа должен быть положительным целым числом.');
    }
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { profile: true, profileCompleted: true, profileCreatedAt: true },
    });
    if (!member?.profileCompleted) throw new Error('Анкета участника не найдена.');

    const answers = parseProfile(member.profile);
    const questions = Object.keys(answers);
    if (questionNumber > questions.length) {
      throw new Error(`Укажите номер ответа от 1 до ${questions.length}.`);
    }
    delete answers[questions[questionNumber - 1]];
    const now = new Date();
    const hasAnswers = Object.keys(answers).length > 0;
    await prisma.conversationMember.update({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      data: {
        profile: JSON.stringify(answers),
        profileCompleted: hasAnswers,
        profileCreatedAt: hasAnswers ? member.profileCreatedAt : null,
        profileUpdatedAt: hasAnswers ? now : null,
      },
    });
    return formatProfile(answers, now);
  }

  async requestProfileDeletion(conversationId: string, vkUserId: string): Promise<boolean> {
    const result = await prisma.conversationMember.updateMany({
      where: { conversationId, vkUserId, profileCompleted: true },
      data: { profileDeleteRequestedAt: new Date() },
    });
    return result.count > 0;
  }

  async confirmProfileDeletion(
    conversationId: string,
    vkUserId: string,
    confirmationWindowMs = 5 * 60_000,
  ): Promise<boolean> {
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { profileDeleteRequestedAt: true },
    });
    if (
      !member?.profileDeleteRequestedAt ||
      Date.now() - member.profileDeleteRequestedAt.getTime() > confirmationWindowMs
    ) {
      return false;
    }
    return this.deleteProfile(conversationId, vkUserId);
  }

  async deleteProfile(conversationId: string, vkUserId: string): Promise<boolean> {
    const result = await prisma.conversationMember.updateMany({
      where: {
        conversationId,
        vkUserId,
        OR: [{ profileCompleted: true }, { questionnaireIndex: { not: null } }],
      },
      data: {
        profile: '{}',
        profileCompleted: false,
        profileCreatedAt: null,
        profileUpdatedAt: null,
        profileDeleteRequestedAt: null,
        questionnaireAnswers: null,
        questionnaireQuestions: null,
        questionnaireIndex: null,
      },
    });
    return result.count > 0;
  }
}

const memberService = new MemberService();
export default memberService;
