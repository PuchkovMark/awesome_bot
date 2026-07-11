import cron from 'node-cron';
import memoryService from '../services/memory/memoryService.js';
import { logger } from '../logger/index.js';

/**
 * Запускает cron-задачу очистки устаревшего контекста каждые N минут.
 */
export function startCleanupJob(minutes = 60) {
  const expr = `*/${minutes} * * * *`;
  cron.schedule(expr, async () => {
    try {
      const deleted = await memoryService.cleanupOldContext();
      logger.info({ deleted }, 'Cleanup job executed');
    } catch (err) {
      logger.error({ err }, 'Cleanup job failed');
    }
  });
  logger.info('Cleanup job scheduled', { minutes });
}
