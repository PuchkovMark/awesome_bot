import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/client.js';
import config from '../../config/index.js';
export type ChatMode = 'active' | 'normal' | 'quiet';
export type ImageAccess = 'admins_only' | 'all';
export type BotRole = 'user' | 'administrator' | 'creator';
export interface RealWorldLocation {
  name: string;
  latitude: number;
  longitude: number;
  countryCode?: string;
  region?: string;
  timeZone?: string;
  population?: number;
}

export const BOT_CREATOR = { name: 'Mark Puchkov', vkId: '388581097' } as const;
export const DEFAULT_WELCOME_TEXT = 'Добро пожаловать, {name}! Рады видеть тебя в беседе.';
export const DEFAULT_QUESTIONNAIRE_QUESTIONS = [
  'Как к тебе обращаться?',
  'Чем ты увлекаешься?',
  'О чём тебе интересно общаться?',
];

/**
 * Читает и сохраняет пользовательские и групповые настройки, роли и параметры приложения.
 */
export class SettingsService {
  async getUserSettings(vkId: string) {
    const user = await prisma.user.upsert({
      where: { vkId },
      create: { vkId },
      update: {},
    });
    return prisma.userSettings.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
    });
  }

  async setUserLocation(vkId: string, location: RealWorldLocation): Promise<void> {
    const settings = await this.getUserSettings(vkId);
    await prisma.userSettings.update({
      where: { id: settings.id },
      data: {
        locationName: location.name,
        locationLatitude: location.latitude,
        locationLongitude: location.longitude,
        locationCountry: location.countryCode ?? null,
        locationRegion: location.region ?? null,
        locationTimeZone: location.timeZone ?? null,
      },
    });
  }

  async setUserTimeZone(vkId: string, timeZone: string): Promise<void> {
    const settings = await this.getUserSettings(vkId);
    await prisma.userSettings.update({
      where: { id: settings.id },
      data: { timeZone: validateTimeZone(timeZone) },
    });
  }

  async setSystemPrompt(vkId: string, prompt: string | null): Promise<void> {
    const trimmed = prompt?.trim() || null;
    if (trimmed && trimmed.length > 2000) {
      throw new Error('System instruction must be 2000 characters or fewer');
    }
    const settings = await this.getUserSettings(vkId);
    await prisma.userSettings.update({
      where: { id: settings.id },
      data: { systemPrompt: trimmed },
    });
  }

  async setChatSystemPrompt(conversationId: string, prompt: string | null): Promise<void> {
    const trimmed = prompt?.trim() || null;
    if (trimmed && trimmed.length > 2000) {
      throw new Error('System instruction must be 2000 characters or fewer');
    }
    const settings = await this.getChatSettings(conversationId);
    await prisma.chatSettings.update({
      where: { id: settings.id },
      data: { systemPrompt: trimmed },
    });
  }

  async getChatSettings(conversationId: string) {
    const conversation = await prisma.conversation.upsert({
      where: { id: conversationId },
      create: { id: conversationId, isGroup: Number(conversationId) >= 2_000_000_000 },
      update: {},
    });
    return prisma.chatSettings.upsert({
      where: { conversationId: conversation.id },
      create: {
        conversationId: conversation.id,
        imageAccess: config.IMAGE_ADMIN_ONLY ? 'admins_only' : 'all',
        welcomeText: DEFAULT_WELCOME_TEXT,
        questionnaireQuestions: JSON.stringify(DEFAULT_QUESTIONNAIRE_QUESTIONS),
      },
      update: {},
    });
  }

  async setChatLocation(conversationId: string, location: RealWorldLocation): Promise<void> {
    const settings = await this.getChatSettings(conversationId);
    await prisma.chatSettings.update({
      where: { id: settings.id },
      data: {
        locationName: location.name,
        locationLatitude: location.latitude,
        locationLongitude: location.longitude,
        locationCountry: location.countryCode ?? null,
        locationRegion: location.region ?? null,
        locationTimeZone: location.timeZone ?? null,
      },
    });
  }

  async setChatTimeZone(conversationId: string, timeZone: string): Promise<void> {
    const settings = await this.getChatSettings(conversationId);
    await prisma.chatSettings.update({
      where: { id: settings.id },
      data: { timeZone: validateTimeZone(timeZone) },
    });
  }

  async updateChatSettings(
    conversationId: string,
    data: {
      welcomeEnabled?: boolean;
      welcomeText?: string;
      questionnaireEnabled?: boolean;
      questionnaireQuestions?: string[];
    },
  ): Promise<void> {
    const settings = await this.getChatSettings(conversationId);
    const { questionnaireQuestions, ...settingsData } = data;
    await prisma.chatSettings.update({
      where: { id: settings.id },
      data: {
        ...settingsData,
        ...(questionnaireQuestions
          ? { questionnaireQuestions: JSON.stringify(questionnaireQuestions) }
          : {}),
      },
    });
  }

  async setChatMode(conversationId: string, mode: ChatMode): Promise<void> {
    const settings = await this.getChatSettings(conversationId);
    await prisma.chatSettings.update({
      where: { id: settings.id },
      data: { mode },
    });
  }

  async setImageAccess(conversationId: string, access: ImageAccess): Promise<void> {
    const settings = await this.getChatSettings(conversationId);
    await prisma.chatSettings.update({
      where: { id: settings.id },
      data: { imageAccess: access },
    });
  }

  async isAdmin(vkId: string): Promise<boolean> {
    return (await this.getRole(vkId)) !== 'user';
  }

  isCreator(vkId: string): boolean {
    return vkId === BOT_CREATOR.vkId;
  }

  async getRole(vkId: string): Promise<BotRole> {
    if (this.isCreator(vkId)) return 'creator';
    if (config.VK_ADMIN_IDS.includes(vkId)) return 'administrator';
    const admin = await prisma.admin.findUnique({ where: { vkId }, select: { id: true } });
    return admin ? 'administrator' : 'user';
  }

  async addAdmin(vkId: string): Promise<void> {
    if (this.isCreator(vkId))
      throw new Error('Создатель не может быть назначен обычным администратором.');
    await prisma.admin.upsert({
      where: { vkId },
      create: { vkId },
      update: {},
    });
  }

  async removeAdmin(vkId: string): Promise<boolean> {
    if (this.isCreator(vkId)) return false;
    if (config.VK_ADMIN_IDS.includes(vkId)) return false;
    const result = await prisma.admin.deleteMany({ where: { vkId } });
    return result.count > 0;
  }

  async getAppSetting(key: string): Promise<string | undefined> {
    const setting = await prisma.appSetting.findUnique({ where: { key } });
    return setting?.value;
  }

  async setAppSetting(key: string, value: string): Promise<void> {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async logAdminAction(adminVkId: string, action: string, details?: string): Promise<void> {
    await prisma.adminLog.create({
      data: { id: randomUUID(), adminVkId, action, details },
    });
  }
}

function validateTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error('Укажите корректный часовой пояс IANA, например Europe/Moscow.');
  }
  return value;
}

const settingsService = new SettingsService();
export default settingsService;
