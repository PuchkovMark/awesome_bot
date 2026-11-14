import config from './config/index.js';
import { connectDb, prisma } from './db/client.js';
import { logger } from './logger/index.js';
import vkService from './services/vk/vkService.js';
import subagentService from './services/ai/subagentService.js';
import { startCleanupJob } from './jobs/cleanupJob.js';
import { startGameTimeoutJob } from './jobs/gameTimeoutJob.js';
import { logScheduledTasksOnStartup, stopAllScheduledTasks } from './jobs/scheduler.js';

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Bot shutdown requested');

  try {
    const scheduledTasksStopped = stopAllScheduledTasks();
    subagentService.stop();
    await vkService.stop();
    const dropped = await subagentService.dropInterruptedJobs();
    const active = await subagentService.countActiveJobs();
    if (active > 0) {
      logger.warn({ active }, 'Active subagent jobs remain after shutdown cleanup');
    }
    logger.info(
      { signal, scheduledTasksStopped, dropped, active },
      'Bot shutdown cleanup complete',
    );
  } catch (error) {
    logger.error({ err: error, signal }, 'Bot shutdown cleanup failed');
  } finally {
    try {
      await prisma.$disconnect();
    } catch (error) {
      logger.warn({ err: error }, 'Prisma disconnect failed during shutdown');
    }
    process.exit(0);
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

async function main() {
  try {
    logger.info('Starting bootstrap');

    // Connect DB
    await connectDb();
    logScheduledTasksOnStartup();

    const dropped = await subagentService.dropInterruptedJobs();
    const active = await subagentService.countActiveJobs();
    if (active > 0) {
      logger.warn({ active }, 'Active subagent jobs remain after startup cleanup');
    } else {
      logger.info({ dropped, active }, 'Subagent job state is clean after startup');
    }

    // Start VK service
    await vkService.start();

    // Start cleanup cron job (every 60 minutes)
    startCleanupJob(60);
    startGameTimeoutJob();

    logger.info(`Bot ${config.BOT_NAME} is running`);
  } catch (err) {
    logger.error({ err }, 'Bootstrap failed');
    process.exit(1);
  }
}

void main();
