import { PrismaClient } from '@prisma/client';
import { logger } from '../logger/index.js';

/**
 * Экземпляр PrismaClient для доступа к БД.
 */
export const prisma = new PrismaClient();

export async function connectDb(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('Prisma connected');
  } catch (err) {
    logger.error({ err }, 'Prisma connection failed');
    throw err;
  }
}

export default prisma;
