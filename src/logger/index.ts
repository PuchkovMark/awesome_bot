import pino from 'pino';
import config from '../config/index';

/**
 * Создаёт и экспортирует pino-логгер.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  }
});

export default logger;
