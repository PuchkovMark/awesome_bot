import cron from 'node-cron';
import { logger } from '../logger/index.js';
import adventureService, { type AdventureResult } from '../services/games/adventureService.js';

export function startAdventureVoteJob(
  publish: (conversationId: string, result: AdventureResult) => Promise<void>,
): void {
  let running = false;
  cron.schedule('* * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const expiredVotes = await adventureService.resolveExpiredVotes();
      for (const { conversationId, result } of expiredVotes) {
        try {
          await publish(conversationId, result);
        } catch (error) {
          logger.error(
            { err: error, conversationId, sessionId: result.sessionId },
            'Failed to publish an expired adventure vote result',
          );
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Adventure vote scheduler failed');
    } finally {
      running = false;
    }
  });
  logger.info('Adventure vote scheduler scheduled');
}
