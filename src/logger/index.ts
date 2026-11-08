import fs from 'node:fs';
import path from 'node:path';
import { multistream, pino } from 'pino';
import config from '../config/index.js';

const LOG_DIR = path.resolve('logs');
const ERROR_LOG_PATH = path.join(LOG_DIR, 'error.log');
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 3;

/**
 * Поток с ротацией по размеру: error.log -> error.log.1 -> ... -> error.log.3.
 * Самый старый файл удаляется. Ошибки ротации не должны ронять приложение.
 */
function createRotatingFileStream(filePath: string): { write: (chunk: string) => void } {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let stream = fs.createWriteStream(filePath, { flags: 'a' });
  let size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  return {
    write(chunk: string) {
      const chunkSize = Buffer.byteLength(chunk);
      if (size + chunkSize > MAX_FILE_SIZE_BYTES && size > 0) {
        try {
          stream.end();
          for (let index = MAX_ROTATED_FILES - 1; index >= 1; index--) {
            const from = `${filePath}.${index}`;
            if (!fs.existsSync(from)) continue;
            if (index === MAX_ROTATED_FILES - 1) fs.unlinkSync(from);
            else fs.renameSync(from, `${filePath}.${index + 1}`);
          }
          fs.renameSync(filePath, `${filePath}.1`);
        } catch {
          // Ротация не удалась — продолжаем писать в текущий файл.
        }
        stream = fs.createWriteStream(filePath, { flags: 'a' });
        size = 0;
      }
      size += chunkSize;
      stream.write(chunk);
    },
  };
}

const prettyStdout = pino.transport({
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:standard',
  },
});

// В консоль — всё согласно LOG_LEVEL; в logs/error.log — только error и fatal (JSON).
const baseLogger = pino(
  { level: config.LOG_LEVEL },
  multistream([
    { level: config.LOG_LEVEL, stream: prettyStdout },
    { level: 'error', stream: createRotatingFileStream(ERROR_LOG_PATH) },
  ]),
);

export const logger = baseLogger;

export default logger;
