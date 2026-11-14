import cron from 'node-cron';
import { logger } from '../logger/index.js';

export function scheduledTaskCount(): number {
  return cron.getTasks().size;
}

export function logScheduledTasksOnStartup(): void {
  const count = scheduledTaskCount();
  if (count > 0) {
    logger.warn({ count }, 'Scheduled tasks already exist before startup');
    return;
  }
  logger.info('Scheduled task registry is clean before startup');
}

export function stopAllScheduledTasks(): number {
  const tasks = cron.getTasks();
  const count = tasks.size;
  for (const task of tasks.values()) {
    task.stop();
  }
  tasks.clear();
  return count;
}
