import config from './config/index.js';
import { connectDb } from './db/client.js';
import { logger } from './logger/index.js';
import vkService from './services/vk/vkService.js';
import { startCleanupJob } from './jobs/cleanupJob.js';

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
