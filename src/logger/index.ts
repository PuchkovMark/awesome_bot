import { pino } from 'pino';
import config from '../config/index.js';

const baseLogger = pino({
  level: config.LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  },
});

export const logger = baseLogger;

export default logger;
