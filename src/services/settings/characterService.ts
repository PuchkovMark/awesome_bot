import { randomUUID } from 'node:crypto';
import { prisma } from '../../db/client.js';
import { logger } from '../../logger/index.js';
import {
  buildPersonalityInstructions,
  defaultPersonality,
  normalizePersonalityId,
  personalities,
  parsePersonalitySettings,
  type PersonalityDefinition,
  type PersonalitySettings,
  validatePersonalitySettings,
} from './personalityService.js';

type Scope = 'direct' | 'chat';
type ProfileRow = Awaited<ReturnType<typeof prisma.personalityProfile.findUnique>>;

const selectionCooldownMs = 10_000;
const lastSelections = new Map<string, number>();
const genericSettings: PersonalitySettings = {
  humor: 50,
  sarcasm: 0,
  emotion: 50,
  length: 50,
  formality: 50,
  emoji: 25,
  detail: 50,
};

function parseIdList(value: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Повреждён список доступа персонажа (${field}).`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Неверный список доступа персонажа (${field}).`);
  }
  return parsed;
}

function parseProfileSettings(value: string, name: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Некорректные настройки персонажа «${name}».`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Некорректные настройки персонажа «${name}».`);
  }
  const record = parsed as Record<string, unknown>;
  const values = validatePersonalitySettings(
    record.values && typeof record.values === 'object' && !Array.isArray(record.values)
      ? (record.values as Record<string, unknown>)
      : {},
  );
  const influences = validatePersonalitySettings(
    record.influences && typeof record.influences === 'object' && !Array.isArray(record.influences)
      ? (record.influences as Record<string, unknown>)
      : {},
  );
  return {
    values: { ...genericSettings, ...values },
    influences: { ...genericSettings, ...influences },
  };
}

function assertText(value: string, field: string, limit: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) {
    throw new Error(`${field}: укажите от 1 до ${limit} символов.`);
  }
  return trimmed;
}

/**
 * Управляет каталогом персонажей бота, их настройками и выбором для пользователя или беседы.
 */
export class CharacterService {
  async initialize(): Promise<void> {
    for (const definition of Object.values(personalities)) {
      const profile = await prisma.personalityProfile.upsert({
        where: { id: definition.id },
        create: {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          example: definition.example,
          systemPrompt: definition.systemPrompt,
          settings: JSON.stringify({
            values: definition.settings,
            influences: definition.influences,
          }),
        },
        update: {},
      });
      await prisma.personalityProfileVersion.upsert({
        where: { personalityId_version: { personalityId: profile.id, version: profile.version } },
        create: {
          personalityId: profile.id,
          version: profile.version,
          name: profile.name,
          description: profile.description,
          example: profile.example,
          systemPrompt: profile.systemPrompt,
          settings: profile.settings,
          enabled: profile.enabled,
          changedBy: 'system',
        },
        update: {},
      });
    }
  }

  async list(scope: Scope, userId: string, peerId: string): Promise<PersonalityDefinition[]> {
    const profiles = await prisma.personalityProfile.findMany({
      where: { enabled: true },
      orderBy: { name: 'asc' },
    });
    return profiles
      .filter((profile) => this.isAvailable(profile, scope, userId, peerId))
      .map((profile) => this.toDefinition(profile));
  }

  async listForAdmin() {
    return prisma.personalityProfile.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        enabled: true,
        directEnabled: true,
        chatEnabled: true,
        version: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async getProfile(
    id: string,
    scope?: Scope,
    userId?: string,
    peerId?: string,
  ): Promise<PersonalityDefinition> {
    const normalized = normalizePersonalityId(id);
    const profile = await prisma.personalityProfile.findUnique({ where: { id: normalized } });
    if (!profile || !profile.enabled) throw new Error('Такой персонаж недоступен.');
    if (scope && userId && peerId && !this.isAvailable(profile, scope, userId, peerId)) {
      throw new Error('Этот персонаж недоступен для текущего диалога.');
    }
    return this.toDefinition(profile);
  }

  async getCurrent(scope: Scope, userId: string, peerId: string) {
    const defaultId = await this.getDefaultPersonalityId();
    const id =
      scope === 'chat'
        ? (await this.getChatSettings(peerId)).personality
        : (await this.getUserSettings(userId)).personality;
    const profile = await prisma.personalityProfile.findUnique({
      where: { id: normalizePersonalityId(id) },
    });
    if (profile && this.isAvailable(profile, scope, userId, peerId))
      return this.toDefinition(profile);
    return this.getProfile(defaultId, scope, userId, peerId);
  }

  async getDefaultPersonalityId(): Promise<string> {
    const setting = await prisma.appSetting.findUnique({ where: { key: 'default_personality' } });
    return setting ? normalizePersonalityId(setting.value) : defaultPersonality;
  }

  async setDefaultPersonality(id: string): Promise<void> {
    const profile = await prisma.personalityProfile.findUnique({
      where: { id: normalizePersonalityId(id) },
    });
    if (!profile || !profile.enabled || !profile.directEnabled || !profile.chatEnabled) {
      throw new Error(
        'Персонаж по умолчанию должен быть включён и доступен в личных сообщениях и беседах.',
      );
    }
    if (
      parseIdList(profile.allowedUsers, 'allowedUsers').length ||
      parseIdList(profile.allowedChats, 'allowedChats').length
    ) {
      throw new Error('Ограниченный персонаж не может быть назначен персонажем по умолчанию.');
    }
    await prisma.appSetting.upsert({
      where: { key: 'default_personality' },
      create: { key: 'default_personality', value: profile.id },
      update: { value: profile.id },
    });
  }

  async select(
    scope: Scope,
    userId: string,
    peerId: string,
    personalityId: string,
  ): Promise<PersonalityDefinition> {
    const definition = await this.getProfile(personalityId, scope, userId, peerId);
    const cooldownKey = `${scope}:${peerId}:${userId}`;
    const setting =
      scope === 'chat' ? await this.getChatSettings(peerId) : await this.getUserSettings(userId);
    const fromId = normalizePersonalityId(setting.personality);
    if (fromId === definition.id) return definition;
    const now = Date.now();
    const previous = lastSelections.get(cooldownKey);
    if (previous !== undefined && now - previous < selectionCooldownMs) {
      throw new Error('Подождите немного перед следующим переключением персонажа.');
    }
    const selectionUpdate =
      scope === 'chat'
        ? prisma.chatSettings.update({
            where: { id: setting.id },
            data: { personality: definition.id },
          })
        : prisma.userSettings.update({
            where: { id: setting.id },
            data: { personality: definition.id },
          });
    await prisma.$transaction([
      selectionUpdate,
      prisma.personalityChange.create({
        data: {
          id: randomUUID(),
          conversationId: peerId,
          scope,
          changedBy: userId,
          fromId,
          toId: definition.id,
        },
      }),
    ]);
    lastSelections.set(cooldownKey, now);
    return definition;
  }

  async getSettings(scope: Scope, userId: string, peerId: string, profileId: string) {
    const profile = await this.getProfile(profileId, scope, userId, peerId);
    const defaults = profile.settings;
    if (scope === 'chat') {
      const settings = await this.getChatSettings(peerId);
      return { ...defaults, ...this.parseChatSettings(settings.personalitySettings)[profile.id] };
    }
    const userSettings = await this.getUserSettings(userId);
    const stored = await prisma.characterUserSetting.findUnique({
      where: {
        userSettingsId_personalityId: {
          userSettingsId: userSettings.id,
          personalityId: profile.id,
        },
      },
    });
    return { ...defaults, ...parsePersonalitySettings(stored?.settings) };
  }

  async setSettings(
    scope: Scope,
    userId: string,
    peerId: string,
    profileId: string,
    updates: Record<string, unknown>,
  ): Promise<PersonalitySettings> {
    const profile = await this.getProfile(profileId, scope, userId, peerId);
    const normalized = validatePersonalitySettings(updates);
    if (Object.keys(normalized).length === 0)
      throw new Error('Укажите хотя бы одну настройку вида humor=70.');
    if (scope === 'chat') {
      const settings = await this.getChatSettings(peerId);
      const allSettings = this.parseChatSettings(settings.personalitySettings);
      const merged = { ...allSettings[profile.id], ...normalized };
      allSettings[profile.id] = merged;
      await prisma.chatSettings.update({
        where: { id: settings.id },
        data: { personalitySettings: JSON.stringify(allSettings) },
      });
      return { ...profile.settings, ...merged };
    }
    const userSettings = await this.getUserSettings(userId);
    const current = await prisma.characterUserSetting.findUnique({
      where: {
        userSettingsId_personalityId: {
          userSettingsId: userSettings.id,
          personalityId: profile.id,
        },
      },
    });
    const merged = { ...parsePersonalitySettings(current?.settings), ...normalized };
    await prisma.characterUserSetting.upsert({
      where: {
        userSettingsId_personalityId: {
          userSettingsId: userSettings.id,
          personalityId: profile.id,
        },
      },
      create: {
        userSettingsId: userSettings.id,
        personalityId: profile.id,
        settings: JSON.stringify(merged),
      },
      update: { settings: JSON.stringify(merged) },
    });
    return { ...profile.settings, ...merged };
  }

  async resetSettings(
    scope: Scope,
    userId: string,
    peerId: string,
    profileId: string,
  ): Promise<void> {
    const profile = await this.getProfile(profileId, scope, userId, peerId);
    if (scope === 'chat') {
      const settings = await this.getChatSettings(peerId);
      const allSettings = this.parseChatSettings(settings.personalitySettings);
      delete allSettings[profile.id];
      await prisma.chatSettings.update({
        where: { id: settings.id },
        data: { personalitySettings: JSON.stringify(allSettings) },
      });
      return;
    }
    const userSettings = await this.getUserSettings(userId);
    await prisma.characterUserSetting.deleteMany({
      where: { userSettingsId: userSettings.id, personalityId: profile.id },
    });
  }

  async setChatChangePermission(peerId: string, enabled: boolean): Promise<void> {
    const chat = await this.getChatSettings(peerId);
    await prisma.chatSettings.update({
      where: { id: chat.id },
      data: { allowPersonalityChange: enabled },
    });
  }

  async canAllMembersChange(peerId: string): Promise<boolean> {
    return (await this.getChatSettings(peerId)).allowPersonalityChange;
  }

  async setAvailability(id: string, scope: Scope, enabled: boolean): Promise<void> {
    const profile = await prisma.personalityProfile.findUnique({
      where: { id: normalizePersonalityId(id) },
    });
    if (!profile) throw new Error('Персонаж не найден.');
    if (!enabled && (await this.getDefaultPersonalityId()) === profile.id) {
      throw new Error('Сначала назначьте другого персонажа по умолчанию.');
    }
    await prisma.personalityProfile.update({
      where: { id: profile.id },
      data: scope === 'direct' ? { directEnabled: enabled } : { chatEnabled: enabled },
    });
  }

  async addExclusiveAccess(id: string, scope: Scope, value: string): Promise<void> {
    await this.updateExclusiveAccess(id, scope, value, true);
  }

  async updateExclusiveAccess(
    id: string,
    scope: Scope,
    value: string,
    allowed: boolean,
  ): Promise<void> {
    const profile = await prisma.personalityProfile.findUnique({
      where: { id: normalizePersonalityId(id) },
    });
    if (!profile) throw new Error('Персонаж не найден.');
    if (allowed && (await this.getDefaultPersonalityId()) === profile.id) {
      throw new Error('Сначала назначьте другого персонажа по умолчанию.');
    }
    const normalizedValue = value.trim();
    if (!/^\d+$/u.test(normalizedValue)) {
      throw new Error('Идентификатор пользователя или беседы должен содержать только цифры.');
    }
    const field = scope === 'direct' ? 'allowedUsers' : 'allowedChats';
    const existing = parseIdList(profile[field], field);
    const updated = allowed
      ? [...new Set([...existing, normalizedValue])]
      : existing.filter((item) => item !== normalizedValue);
    await prisma.personalityProfile.update({
      where: { id: profile.id },
      data: { [field]: JSON.stringify(updated) },
    });
  }

  async updateProfileSettings(
    id: string,
    values: Record<string, unknown>,
    influences: Record<string, unknown>,
    changedBy: string,
  ): Promise<void> {
    const profile = await prisma.personalityProfile.findUnique({
      where: { id: normalizePersonalityId(id) },
    });
    if (!profile) throw new Error('Персонаж не найден.');
    const current = parseProfileSettings(profile.settings, profile.name);
    const next = {
      values: { ...current.values, ...validatePersonalitySettings(values) },
      influences: { ...current.influences, ...validatePersonalitySettings(influences) },
    };
    const version = profile.version + 1;
    await prisma.$transaction([
      prisma.personalityProfileVersion.create({
        data: {
          personalityId: profile.id,
          version,
          name: profile.name,
          description: profile.description,
          example: profile.example,
          systemPrompt: profile.systemPrompt,
          settings: JSON.stringify(next),
          enabled: profile.enabled,
          changedBy,
        },
      }),
      prisma.personalityProfile.update({
        where: { id: profile.id },
        data: { settings: JSON.stringify(next), version },
      }),
    ]);
  }

  async getSystemInstruction(
    scope: Scope,
    userId: string,
    peerId: string,
  ): Promise<{ definition: PersonalityDefinition; prompt: string }> {
    const definition = await this.getCurrent(scope, userId, peerId);
    const overrides = await this.getSettings(scope, userId, peerId, definition.id);
    return { definition, prompt: buildPersonalityInstructions(definition, overrides) };
  }

  async recordUsage(
    personalityId: string,
    userId: string,
    conversationId: string,
    scope: Scope,
  ): Promise<void> {
    try {
      await prisma.personalityUsage.create({
        data: { personalityId, vkUserId: userId, conversationId, scope },
      });
    } catch (err) {
      logger.warn({ err, personalityId, conversationId }, 'Failed to record personality usage');
    }
  }

  async getUsageStats(personalityId?: string) {
    const usage = await prisma.personalityUsage.groupBy({
      by: ['personalityId', 'scope'],
      where: personalityId ? { personalityId: normalizePersonalityId(personalityId) } : undefined,
      _count: { _all: true },
      orderBy: { _count: { personalityId: 'desc' } },
    });
    const profiles = await prisma.personalityProfile.findMany({
      where: { id: { in: usage.map(({ personalityId: id }) => id) } },
      select: { id: true, name: true },
    });
    const names = new Map(profiles.map(({ id, name }) => [id, name]));
    return usage.map(({ personalityId: id, scope, _count }) => ({
      id,
      name: names.get(id) ?? id,
      scope,
      count: _count._all,
    }));
  }

  async createProfile(
    id: string,
    name: string,
    description: string,
    example: string,
    prompt: string,
    changedBy: string,
  ): Promise<void> {
    const normalizedId = id.trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(normalizedId))
      throw new Error('ID должен содержать 2–32 латинских символа, цифр, _ или -.');
    if (normalizePersonalityId(normalizedId) !== normalizedId) {
      throw new Error('Этот ID зарезервирован для совместимости со старым профилем.');
    }
    const profileData = {
      id: normalizedId,
      name: assertText(name, 'Имя', 80),
      description: assertText(description, 'Описание', 300),
      example: assertText(example, 'Пример', 300),
      systemPrompt: assertText(prompt, 'Инструкция', 4000),
      settings: JSON.stringify({ values: genericSettings, influences: genericSettings }),
    };
    await prisma.$transaction([
      prisma.personalityProfile.create({ data: profileData }),
      prisma.personalityProfileVersion.create({
        data: {
          personalityId: normalizedId,
          version: 1,
          name: profileData.name,
          description: profileData.description,
          example: profileData.example,
          systemPrompt: profileData.systemPrompt,
          settings: profileData.settings,
          changedBy,
        },
      }),
    ]);
  }

  async updateProfile(
    id: string,
    changes: Partial<
      Pick<PersonalityDefinition, 'name' | 'description' | 'example' | 'systemPrompt'>
    >,
    changedBy: string,
  ): Promise<void> {
    const profile = await prisma.personalityProfile.findUnique({
      where: { id: normalizePersonalityId(id) },
    });
    if (!profile) throw new Error('Персонаж не найден.');
    const version = profile.version + 1;
    const updated = {
      name: changes.name ? assertText(changes.name, 'Имя', 80) : profile.name,
      description: changes.description
        ? assertText(changes.description, 'Описание', 300)
        : profile.description,
      example: changes.example ? assertText(changes.example, 'Пример', 300) : profile.example,
      systemPrompt: changes.systemPrompt
        ? assertText(changes.systemPrompt, 'Инструкция', 4000)
        : profile.systemPrompt,
    };
    await prisma.$transaction([
      prisma.personalityProfileVersion.create({
        data: {
          personalityId: profile.id,
          version,
          ...updated,
          settings: profile.settings,
          enabled: profile.enabled,
          changedBy,
        },
      }),
      prisma.personalityProfile.update({
        where: { id: profile.id },
        data: { ...updated, version },
      }),
    ]);
  }

  async setEnabled(id: string, enabled: boolean, changedBy: string): Promise<void> {
    const profile = await prisma.personalityProfile.findUnique({
      where: { id: normalizePersonalityId(id) },
    });
    if (!profile) throw new Error('Персонаж не найден.');
    if (!enabled && (await this.getDefaultPersonalityId()) === profile.id) {
      throw new Error('Сначала назначьте другого персонажа по умолчанию.');
    }
    const version = profile.version + 1;
    await prisma.$transaction([
      prisma.personalityProfileVersion.create({
        data: {
          personalityId: profile.id,
          version,
          name: profile.name,
          description: profile.description,
          example: profile.example,
          systemPrompt: profile.systemPrompt,
          settings: profile.settings,
          enabled,
          changedBy,
        },
      }),
      prisma.personalityProfile.update({ where: { id: profile.id }, data: { enabled, version } }),
    ]);
  }

  async rollbackProfile(id: string, version: number, changedBy: string): Promise<void> {
    const profile = await prisma.personalityProfile.findUnique({
      where: { id: normalizePersonalityId(id) },
    });
    if (!profile) throw new Error('Персонаж не найден.');
    const snapshot = await prisma.personalityProfileVersion.findUnique({
      where: { personalityId_version: { personalityId: profile.id, version } },
    });
    if (!snapshot) throw new Error('Версия персонажа не найдена.');
    const nextVersion = profile.version + 1;
    await prisma.$transaction([
      prisma.personalityProfileVersion.create({
        data: {
          personalityId: profile.id,
          version: nextVersion,
          name: snapshot.name,
          description: snapshot.description,
          example: snapshot.example,
          systemPrompt: snapshot.systemPrompt,
          settings: snapshot.settings,
          enabled: snapshot.enabled,
          changedBy,
        },
      }),
      prisma.personalityProfile.update({
        where: { id: profile.id },
        data: {
          name: snapshot.name,
          description: snapshot.description,
          example: snapshot.example,
          systemPrompt: snapshot.systemPrompt,
          settings: snapshot.settings,
          enabled: snapshot.enabled,
          version: nextVersion,
        },
      }),
    ]);
  }

  private async getUserSettings(vkId: string) {
    const user = await prisma.user.upsert({ where: { vkId }, create: { vkId }, update: {} });
    return prisma.userSettings.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
    });
  }

  private async getChatSettings(peerId: string) {
    const conversation = await prisma.conversation.upsert({
      where: { id: peerId },
      create: { id: peerId, isGroup: Number(peerId) >= 2_000_000_000 },
      update: {},
    });
    return prisma.chatSettings.upsert({
      where: { conversationId: conversation.id },
      create: { conversationId: conversation.id },
      update: {},
    });
  }

  private parseChatSettings(value: string): Record<string, Partial<PersonalitySettings>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error('Сохранённые настройки персонажей беседы имеют неверный формат.', {
        cause: error,
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Сохранённые настройки персонажей беседы должны быть объектом.');
    }
    const result: Record<string, Partial<PersonalitySettings>> = {};
    for (const [id, settings] of Object.entries(parsed)) {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error(`Повреждены настройки персонажа ${id} в беседе.`);
      }
      result[id] = validatePersonalitySettings(settings as Record<string, unknown>);
    }
    return result;
  }

  private isAvailable(
    profile: NonNullable<ProfileRow>,
    scope: Scope,
    userId: string,
    peerId: string,
  ): boolean {
    if (!profile.enabled || (scope === 'direct' ? !profile.directEnabled : !profile.chatEnabled))
      return false;
    const users = parseIdList(profile.allowedUsers, 'allowedUsers');
    const chats = parseIdList(profile.allowedChats, 'allowedChats');
    return (!users.length || users.includes(userId)) && (!chats.length || chats.includes(peerId));
  }

  private toDefinition(profile: NonNullable<ProfileRow>): PersonalityDefinition {
    const settings = parseProfileSettings(profile.settings, profile.name);
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      example: profile.example,
      systemPrompt: profile.systemPrompt,
      settings: settings.values,
      influences: settings.influences,
    };
  }
}

const characterService = new CharacterService();
export default characterService;
