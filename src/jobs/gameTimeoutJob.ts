import cron from 'node-cron';
import { logger } from '../logger/index.js';
import gameService from '../services/games/gameService.js';
import mafiaService from '../services/games/mafiaService.js';
import senderService from '../services/sender/senderService.js';

export function startGameTimeoutJob(): void {
  let running = false;
  cron.schedule('*/10 * * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const expired = [
        ...(await gameService.handleTimeouts()),
        ...(await mafiaService.handleTimeouts()),
      ];
      for (const result of expired) {
        try {
          await senderService.send(Number(result.conversationId), result.text);
        } catch (error) {
          logger.error(
            { err: error, conversationId: result.conversationId },
            'Failed to publish a game timeout result',
          );
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Game timeout scheduler failed');
    } finally {
      running = false;
    }
  });
  logger.info('Game timeout scheduler scheduled');
}
