import config from './config/index';
import { connectDb } from './db/client';
import { logger } from './logger';
import vkService from './services/vk/vkService';
import { startCleanupJob } from './jobs/cleanupJob';

async function main() {
  try {
    logger.info('Starting bootstrap');

    // Connect DB
    await connectDb();

    // Start VK service
    await vkService.start();

    // Start cleanup cron job (every 60 minutes)
    startCleanupJob(60);

    logger.info(`Bot ${config.BOT_NAME} is running`);
  } catch (err) {
    logger.error({ err }, 'Bootstrap failed');
    process.exit(1);
  }
}

main();
