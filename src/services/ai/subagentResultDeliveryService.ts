import config from '../../config/index.js';
import { prisma } from '../../db/client.js';
import { logger } from '../../logger/index.js';
import settingsService from '../settings/settingsService.js';
import { isLongEnoughForAutomaticVoice } from '../voice/voiceLimits.js';
import { sendVoiceAwareResponse } from '../voice/voiceResponseService.js';

const DELIVERY_BATCH_SIZE = 10;

type DeliveryJob = {
  id: string;
  conversationId: string;
  userId: string;
  result: string | null;
  messageId: number | null;
  conversationMessageId: number | null;
};

function replyOptions(job: DeliveryJob): { replyTo?: number; conversationMessageId?: number } {
  return {
    ...(job.messageId && job.messageId > 0 ? { replyTo: job.messageId } : {}),
    ...(job.conversationMessageId && job.conversationMessageId > 0
      ? { conversationMessageId: job.conversationMessageId }
      : {}),
  };
}

/**
 * Доставляет готовые результаты субагентов в VK. Субагенты сообщения не отправляют.
 */
export class SubagentResultDeliveryService {
  private readonly inFlight = new Set<string>();

  async processPendingResults(): Promise<void> {
    const jobs = await prisma.digestJob.findMany({
      where: {
        result: { not: null },
        resultSentAt: null,
        status: { in: ['done', 'partial', 'failed'] },
      },
      orderBy: { completedAt: 'asc' },
      take: DELIVERY_BATCH_SIZE,
      select: { id: true },
    });
    for (const job of jobs) {
      await this.deliver(job.id);
    }
  }

  async deliver(jobId: string): Promise<boolean> {
    if (this.inFlight.has(jobId)) return false;
    this.inFlight.add(jobId);
    try {
      const job = await prisma.digestJob.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          conversationId: true,
          userId: true,
          result: true,
          messageId: true,
          conversationMessageId: true,
          resultSentAt: true,
          status: true,
        },
      });
      if (!job || !job.result || job.resultSentAt) return false;
      if (!['done', 'partial', 'failed'].includes(job.status)) return false;

      const resultText = job.result.trim();
      if (!resultText) {
        await prisma.digestJob.update({
          where: { id: job.id },
          data: { resultSentAt: new Date() },
        });
        return true;
      }

      const peerId = Number(job.conversationId);
      if (!Number.isSafeInteger(peerId) || peerId < 1) {
        logger.error(
          { jobId: job.id, conversationId: job.conversationId },
          'Unable to deliver subagent result to an invalid conversation',
        );
        return false;
      }

      let voice: string | undefined;
      try {
        const userSettings = await settingsService.getUserSettings(job.userId);
        if (
          config.VOICE_ENABLED &&
          userSettings.voiceEnabled &&
          isLongEnoughForAutomaticVoice(resultText)
        ) {
          voice = userSettings.voice || 'coral';
        }
      } catch (error) {
        logger.warn(
          { err: error, jobId: job.id, userId: job.userId },
          'Unable to load voice settings for subagent result',
        );
      }

      await sendVoiceAwareResponse({
        peerId,
        text: resultText,
        ...(voice ? { voice } : {}),
        options: replyOptions(job),
        recordUsage: () => this.recordVoiceUsage(job.userId, job.conversationId),
      });
      await prisma.digestJob.update({
        where: { id: job.id },
        data: { resultSentAt: new Date() },
      });
      return true;
    } catch (error) {
      logger.warn(
        {
          err: error,
          jobId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
        'Unable to deliver subagent result; will retry',
      );
      return false;
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  private async recordVoiceUsage(vkUserId: string, conversationId: string): Promise<void> {
    try {
      await prisma.apiUsage.create({
        data: {
          vkUserId,
          conversationId,
          provider: 'openai',
          feature: 'voice',
        },
      });
    } catch (error) {
      logger.warn(
        { err: error, vkUserId, conversationId },
        'Unable to record subagent voice usage',
      );
    }
  }
}

const subagentResultDeliveryService = new SubagentResultDeliveryService();
export default subagentResultDeliveryService;
