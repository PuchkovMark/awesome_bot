import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/client.js';
import config from '../../config/index.js';
import { isPersonalityId, type PersonalityId } from './personalityService.js';

export type ChatMode = 'active' | 'normal' | 'quiet';
export type ImageAccess = 'admins_only' | 'all';

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

  async setPersonality(vkId: string, value: string): Promise<PersonalityId> {
    if (!isPersonalityId(value)) throw new Error('Unknown personality');
    const settings = await this.getUserSettings(vkId);
    await prisma.userSettings.update({
      where: { id: settings.id },
      data: { personality: value },
    });
    return value;
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
      },
      update: {},
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
    if (config.VK_ADMIN_IDS.includes(vkId)) return true;
    return Boolean(await prisma.admin.findUnique({ where: { vkId }, select: { id: true } }));
  }

  async addAdmin(vkId: string): Promise<void> {
    await prisma.admin.upsert({
      where: { vkId },
      create: { vkId },
      update: {},
    });
  }

  async removeAdmin(vkId: string): Promise<boolean> {
    if (config.VK_ADMIN_IDS.includes(vkId)) return false;
    if (config.VK_ADMIN_IDS.length === 0 && (await prisma.admin.count()) <= 1) return false;
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

const settingsService = new SettingsService();
export default settingsService;
