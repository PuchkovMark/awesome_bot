import { prisma } from '../../db/client.js';
import settingsService from '../settings/settingsService.js';

export const MAX_QUESTIONNAIRE_QUESTIONS = 8;
export const MAX_QUESTION_LENGTH = 200;
export const MAX_ANSWER_LENGTH = 500;
export const MEMBER_PROFILES_PAGE_SIZE = 10;

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

function formatProfile(answers: Record<string, string>): string {
  return Object.entries(answers)
    .map(([question, answer]) => `${question}\n${answer}`)
    .join('\n\n');
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
  async recordJoin(conversationId: string, vkUserId: string) {
    const settings = await settingsService.getChatSettings(conversationId);
    const existing = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { id: true },
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
    return {
      isReturning: Boolean(existing),
      welcomeEnabled: settings.welcomeEnabled,
      welcomeText: settings.welcomeText,
      questionnaireEnabled: settings.questionnaireEnabled,
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

  async startQuestionnaire(
    conversationId: string,
    vkUserId: string,
    replaceExisting = false,
  ): Promise<{ prompt: string; alreadyExists: boolean }> {
    const settings = await settingsService.getChatSettings(conversationId);
    if (!settings.questionnaireEnabled) {
      throw new Error('Анкеты в этой беседе выключены. Попросите администратора включить их.');
    }

    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { profile: true, questionnaireIndex: true },
    });
    if (member?.questionnaireIndex !== null && member?.questionnaireIndex !== undefined) {
      throw new Error(
        'Анкета уже заполняется. Ответьте на текущий вопрос или отправьте /profile cancel.',
      );
    }
    if (member && member.profile !== '{}' && !replaceExisting) {
      throw new Error('У вас уже есть анкета. Для изменения используйте /profile edit.');
    }

    const questions = parseStoredQuestionnaireQuestions(settings.questionnaireQuestions);
    await prisma.conversationMember.upsert({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      create: {
        conversationId,
        vkUserId,
        isPresent: true,
        questionnaireQuestions: JSON.stringify(questions),
        questionnaireAnswers: '{}',
        questionnaireIndex: 0,
      },
      update: {
        isPresent: true,
        questionnaireQuestions: JSON.stringify(questions),
        questionnaireAnswers: '{}',
        questionnaireIndex: 0,
      },
    });
    return { prompt: questions[0], alreadyExists: Boolean(member && member.profile !== '{}') };
  }

  async answerQuestionnaire(
    conversationId: string,
    vkUserId: string,
    answer: string,
  ): Promise<{ prompt?: string; completed?: string }> {
    const trimmed = answer.trim();
    if (!trimmed) return { prompt: 'Ответ не может быть пустым. Попробуйте ещё раз.' };
    if (trimmed.length > MAX_ANSWER_LENGTH) {
      return { prompt: `Ответ слишком длинный. Максимум — ${MAX_ANSWER_LENGTH} символов.` };
    }

    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: {
        questionnaireQuestions: true,
        questionnaireAnswers: true,
        questionnaireIndex: true,
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
    if (index < 0 || index >= questions.length) {
      throw new Error('Анкета содержит недопустимый номер вопроса.');
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
        questionnaireAnswers: null,
        questionnaireQuestions: null,
        questionnaireIndex: null,
      },
    });
    return {
      completed: Object.entries(answers)
        .map(([question, value]) => `${question}\n${value}`)
        .join('\n\n'),
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

  async getProfile(conversationId: string, vkUserId: string): Promise<string | undefined> {
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      select: { profile: true },
    });
    if (!member || member.profile === '{}') return undefined;
    return formatProfile(parseProfile(member.profile));
  }

  async listProfiles(conversationId: string, page: number) {
    if (!Number.isInteger(page) || page < 1)
      throw new Error('Номер страницы должен быть больше нуля.');
    const where = { conversationId, profile: { not: '{}' } };
    const total = await prisma.conversationMember.count({ where });
    const pageCount = Math.ceil(total / MEMBER_PROFILES_PAGE_SIZE);
    if (page > pageCount) {
      return { total, page, pageCount, profiles: [] };
    }
    const members = await prisma.conversationMember.findMany({
      where,
      select: { vkUserId: true, profile: true },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * MEMBER_PROFILES_PAGE_SIZE,
      take: MEMBER_PROFILES_PAGE_SIZE,
    });
    return {
      total,
      page,
      pageCount,
      profiles: members.map(({ vkUserId, profile }) => ({
        vkUserId,
        answers: parseProfile(profile),
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
      select: { profile: true },
    });
    if (!member || member.profile === '{}') throw new Error('Анкета участника не найдена.');

    const answers = parseProfile(member.profile);
    const questions = Object.keys(answers);
    if (questionNumber > questions.length) {
      throw new Error(`Укажите номер ответа от 1 до ${questions.length}.`);
    }
    answers[questions[questionNumber - 1]] = trimmed;
    await prisma.conversationMember.update({
      where: { conversationId_vkUserId: { conversationId, vkUserId } },
      data: { profile: JSON.stringify(answers) },
    });
    return formatProfile(answers);
  }

  async deleteProfile(conversationId: string, vkUserId: string): Promise<boolean> {
    const result = await prisma.conversationMember.updateMany({
      where: {
        conversationId,
        vkUserId,
        OR: [{ profile: { not: '{}' } }, { questionnaireIndex: { not: null } }],
      },
      data: {
        profile: '{}',
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
