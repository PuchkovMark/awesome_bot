import cron from 'node-cron';
import { logger } from '../logger/index.js';
import longTermMemoryService from '../services/memory/longTermMemoryService.js';

export function startLongTermMemoryJob(): void {
  let running = false;
  cron.schedule('15 3 * * *', async () => {
    if (running) return;
    running = true;
    try {
      await longTermMemoryService.archiveExpiredMemories();
    } catch (error) {
      logger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'Failed to archive expired long-term memories',
      );
    } finally {
      running = false;
    }
  });
}
