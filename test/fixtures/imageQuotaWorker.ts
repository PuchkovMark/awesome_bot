import { PrismaClient } from '@prisma/client';
import { ImageQuotaService } from '../../src/services/image/imageQuotaService.js';

const [databaseUrl, operationId, time, mode] = process.argv.slice(2);
if (!databaseUrl || !operationId || !time) throw new Error('Missing worker arguments');
const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const quota = new ImageQuotaService(client, () => new Date(time));
await client.$connect();

process.once('message', () => {
  void (async () => {
    try {
      const result = await quota.reserve({
        operationId,
        vkUserId: 'worker',
        feature: 'image_generate',
      });
      if (mode === 'crash' && result.status === 'reserved') {
        // Имитируем остановку процесса после commit, без finish/disconnect.
        process.exit(0);
      }
      process.send?.({ status: result.status });
    } catch {
      process.send?.({ status: 'database_error' });
    } finally {
      await client.$disconnect();
      process.disconnect();
    }
  })();
});
process.send?.({ status: 'ready' });
