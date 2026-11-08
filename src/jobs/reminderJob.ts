import cron from 'node-cron';
import { logger } from '../logger/index.js';
import reminderService from '../services/reminders/reminderService.js';

export function startReminderJob(): void {
  let running = false;
  cron.schedule('* * * * *', async () => {
    if (running) return;
    running = true;
    try {
      await reminderService.processDueReminders();
    } catch (error) {
      logger.error({ err: error }, 'Reminder scheduler failed');
    } finally {
      running = false;
    }
  });
  logger.info('Reminder scheduler scheduled');
}
