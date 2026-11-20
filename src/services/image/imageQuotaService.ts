import type { PrismaClient } from '@prisma/client';
import config from '../../config/index.js';
import prisma from '../../db/client.js';

export type ImageQuotaFeature = 'image_generate' | 'image_edit';
export type ImageQuotaOutcome = 'consumed' | 'uncertain' | 'released';
export type ImageQuotaReservation =
  | { status: 'reserved'; operationId: string; utcDay: string; reservedAt: Date }
  | { status: 'limit_reached' }
  | { status: 'already_processed' };

/** Общий устойчивый допуск команд и tool; телеметрия не управляет квотой. */
export class ImageQuotaService {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reserve(input: {
    operationId: string;
    vkUserId: string;
    feature: ImageQuotaFeature;
  }): Promise<ImageQuotaReservation> {
    const reservedAt = this.now();
    const utcDay = reservedAt.toISOString().slice(0, 10);
    const dayStart = new Date(`${utcDay}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const { operationId, vkUserId, feature } = input;

    return this.client.$transaction<ImageQuotaReservation>(async (tx) => {
      // Первый запрос получает writer lock до чтения legacy usage.
      const inserted = await tx.$executeRaw`
        INSERT OR IGNORE INTO "ImageDailyQuota"
          ("vkUserId", "utcDay", "used", "legacyUsed", "createdAt", "updatedAt")
        VALUES (${vkUserId}, ${utcDay}, 0, 0, ${reservedAt}, ${reservedAt})
      `;
      if (inserted === 1) {
        const legacyUsed = await tx.apiUsage.count({
          where: {
            vkUserId,
            feature: { in: ['image_generate', 'image_edit'] },
            createdAt: { gte: dayStart, lt: dayEnd },
          },
        });
        await tx.imageDailyQuota.update({
          where: { vkUserId_utcDay: { vkUserId, utcDay } },
          data: { used: legacyUsed, legacyUsed },
        });
      }
      const existing = await tx.imageQuotaAttempt.findUnique({ where: { operationId } });
      if (existing) {
        if (existing.vkUserId !== vkUserId || existing.feature !== feature) {
          throw new Error('Image quota operation identity mismatch');
        }
        return { status: 'already_processed' };
      }
      const updated = await tx.imageDailyQuota.updateMany({
        where: { vkUserId, utcDay, used: { lt: config.IMAGE_MAX_PER_USER_PER_DAY } },
        data: { used: { increment: 1 } },
      });
      if (updated.count === 0) return { status: 'limit_reached' };
      await tx.imageQuotaAttempt.create({
        data: { operationId, vkUserId, utcDay, feature, createdAt: reservedAt },
      });
      return { status: 'reserved', operationId, utcDay, reservedAt };
    });
  }

  async finish(operationId: string, outcome: ImageQuotaOutcome): Promise<void> {
    await this.client.$transaction(async (tx) => {
      const updated = await tx.imageQuotaAttempt.updateMany({
        where: { operationId, status: 'reserved' },
        data: { status: outcome },
      });
      const attempt = await tx.imageQuotaAttempt.findUnique({ where: { operationId } });
      if (!attempt) throw new Error('Unknown image quota operation');
      if (updated.count === 0 || outcome !== 'released') return;
      const daily = await tx.imageDailyQuota.findUniqueOrThrow({
        where: { vkUserId_utcDay: { vkUserId: attempt.vkUserId, utcDay: attempt.utcDay } },
      });
      const quota = await tx.imageDailyQuota.updateMany({
        where: {
          vkUserId: attempt.vkUserId,
          utcDay: attempt.utcDay,
          used: { gt: daily.legacyUsed },
        },
        data: { used: { decrement: 1 } },
      });
      if (quota.count !== 1) throw new Error('Image quota counter invariant violated');
    });
  }
}

export default new ImageQuotaService();
