import cron from 'node-cron';
import { logger } from '../logger/index.js';
import subagentResultDeliveryService from '../services/ai/subagentResultDeliveryService.js';

/**
 * Доставляет завершённые результаты субагентов, если их не удалось отправить сразу.
 */
export function startSubagentDeliveryJob(): void {
  let running = false;
  const process = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await subagentResultDeliveryService.processPendingResults();
    } catch (error) {
      logger.error({ err: error }, 'Subagent delivery job failed');
    } finally {
      running = false;
    }
  };

  cron.schedule('* * * * *', () => {
    void process();
  });
  void process();
  logger.info('Subagent delivery job scheduled');
}
