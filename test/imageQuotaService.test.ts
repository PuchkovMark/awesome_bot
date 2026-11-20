// Пути ограничены mkdtemp и фиксированной историей миграций; команды без shell.
/* eslint-disable security/detect-non-literal-fs-filename */
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import config from '../src/config/index.js';
import { ImageQuotaService } from '../src/services/image/imageQuotaService.js';

const time = new Date('2026-11-20T12:00:00Z');
const migrationName = '20261120000000_image_daily_quota';
const prismaCli = path.resolve('node_modules/prisma/build/index.js');

test(
  'durable image quota uses the real SQLite schema and transactions',
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'image-quota-'));
    const clients: PrismaClient[] = [];
    t.after(async () => {
      await Promise.all(clients.map((client) => client.$disconnect()));
      await rm(root, { recursive: true, force: true });
    });
    const templateUrl = `file:${path.join(root, 'template.db')}`;
    const migrate = (schema: string, url: string) => {
      execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
    };
    migrate(path.resolve('prisma/schema.prisma'), templateUrl);
    const fixture = async (name: string) => {
      const filename = path.join(root, `${name}.db`);
      await cp(path.join(root, 'template.db'), filename);
      const client = new PrismaClient({ datasources: { db: { url: `file:${filename}` } } });
      clients.push(client);
      return { client, url: `file:${filename}`, quota: new ImageQuotaService(client, () => time) };
    };
    const reserve = (quota: ImageQuotaService, operationId: string, vkUserId = 'user') =>
      quota.reserve({ operationId, vkUserId, feature: 'image_generate' });

    await t.test(
      'seed is scoped by author, feature and UTC day, once and without truncation',
      async () => {
        const { client, quota } = await fixture('seed');
        await client.apiUsage.createMany({
          data: [
            {
              provider: 'openai',
              feature: 'image_generate',
              vkUserId: 'user',
              conversationId: 'a',
              createdAt: time,
              estimatedCost: 1.25,
            },
            {
              provider: 'openai',
              feature: 'image_edit',
              vkUserId: 'user',
              conversationId: 'b',
              createdAt: time,
            },
            {
              provider: 'openai',
              feature: 'image_generate',
              vkUserId: 'user',
              createdAt: new Date('2026-11-19T23:59:59Z'),
            },
            {
              provider: 'openai',
              feature: 'image_generate',
              vkUserId: 'user',
              createdAt: new Date('2026-11-21T00:00:00Z'),
            },
            { provider: 'openai', feature: 'voice', vkUserId: 'user', createdAt: time },
            { provider: 'openai', feature: 'image_generate', vkUserId: 'other', createdAt: time },
            { provider: 'openai', feature: 'image_generate', createdAt: time },
          ],
        });
        assert.equal((await reserve(quota, 'first')).status, 'reserved');
        await client.apiUsage.create({
          data: {
            provider: 'openai',
            feature: 'image_generate',
            vkUserId: 'user',
            createdAt: time,
          },
        });
        assert.equal((await reserve(quota, 'first')).status, 'already_processed');
        assert.equal((await reserve(quota, 'second')).status, 'reserved');
        const row = await client.imageDailyQuota.findUniqueOrThrow({
          where: { vkUserId_utcDay: { vkUserId: 'user', utcDay: '2026-11-20' } },
        });
        assert.equal(row.legacyUsed, 2);
        assert.equal(row.used, 4);
        await assert.rejects(reserve(quota, 'first', 'other'), /identity mismatch/u);
        const savedLimit = config.IMAGE_MAX_PER_USER_PER_DAY;
        config.IMAGE_MAX_PER_USER_PER_DAY = 1;
        try {
          await client.apiUsage.createMany({
            data: [0, 1].map(() => ({
              provider: 'openai',
              feature: 'image_generate',
              vkUserId: 'over',
              createdAt: time,
            })),
          });
          assert.equal((await reserve(quota, 'over-limit', 'over')).status, 'limit_reached');
          assert.equal(
            (await client.imageDailyQuota.findFirstOrThrow({ where: { vkUserId: 'over' } })).used,
            2,
          );
        } finally {
          config.IMAGE_MAX_PER_USER_PER_DAY = savedLimit;
        }
      },
    );

    await t.test(
      'release and terminal outcomes are idempotent and persist for a new client',
      async () => {
        const { client, quota, url } = await fixture('transitions');
        await reserve(quota, 'release');
        await quota.finish('release', 'released');
        await quota.finish('release', 'released');
        await reserve(quota, 'consume');
        await quota.finish('consume', 'consumed');
        await quota.finish('consume', 'released');
        await reserve(quota, 'uncertain');
        await quota.finish('uncertain', 'uncertain');
        await quota.finish('uncertain', 'released');
        await assert.rejects(quota.finish('missing', 'released'), /Unknown/u);
        await client.$disconnect();
        const reopened = new PrismaClient({ datasources: { db: { url } } });
        clients.push(reopened);
        assert.equal((await reopened.imageDailyQuota.findFirstOrThrow()).used, 2);
        assert.deepEqual(
          (await reopened.imageQuotaAttempt.findMany({ orderBy: { operationId: 'asc' } })).map(
            (row) => row.status,
          ),
          ['consumed', 'released', 'uncertain'],
        );
      },
    );

    await t.test('attempt insertion failure rolls back increment and seed', async () => {
      const { client, quota } = await fixture('rollback');
      await client.$executeRaw`CREATE TRIGGER fail_attempt BEFORE INSERT ON "ImageQuotaAttempt" BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
      await assert.rejects(reserve(quota, 'fail'));
      assert.equal(await client.imageDailyQuota.count(), 0);
      assert.equal(await client.imageQuotaAttempt.count(), 0);
    });

    await t.test('invalid counter rolls back release rather than hiding corruption', async () => {
      const { client, quota } = await fixture('invariant');
      await reserve(quota, 'invalid');
      await client.imageDailyQuota.updateMany({ data: { used: 0 } });
      await assert.rejects(quota.finish('invalid', 'released'), /invariant/u);
      assert.equal(
        (await client.imageQuotaAttempt.findUniqueOrThrow({ where: { operationId: 'invalid' } }))
          .status,
        'reserved',
      );
    });

    await t.test('UTC midnight and late usage never seed the same operation twice', async () => {
      const { client } = await fixture('midnight');
      let clock = new Date('2026-11-20T23:59:59Z');
      const quota = new ImageQuotaService(client, () => clock);
      const result = await reserve(quota, 'before-midnight');
      assert.equal(result.status, 'reserved');
      if (result.status !== 'reserved') assert.fail('Missing reservation');
      clock = new Date('2026-11-21T00:00:01Z');
      await quota.finish('before-midnight', 'consumed');
      await client.apiUsage.create({
        data: {
          vkUserId: 'user',
          provider: 'openai',
          feature: 'image_generate',
          createdAt: result.reservedAt,
        },
      });
      assert.equal((await reserve(quota, 'next-day')).status, 'reserved');
      assert.equal((await reserve(quota, 'before-midnight')).status, 'already_processed');
      const rows = await client.imageDailyQuota.findMany({ orderBy: { utcDay: 'asc' } });
      assert.deepEqual(
        rows.map((row) => [row.used, row.legacyUsed]),
        [
          [1, 0],
          [1, 0],
        ],
      );
    });

    await t.test(
      'separate processes serialize first seed and preserve an interrupted reservation',
      async () => {
        const { client, url } = await fixture('workers');
        await client.apiUsage.createMany({
          data: Array.from({ length: config.IMAGE_MAX_PER_USER_PER_DAY - 1 }, () => ({
            provider: 'openai',
            vkUserId: 'worker',
            feature: 'image_generate',
            createdAt: time,
          })),
        });
        const spawn = (id: string, mode = 'normal') => {
          const worker = fork(
            fileURLToPath(new URL('fixtures/imageQuotaWorker.ts', import.meta.url)),
            [url, id, time.toISOString(), mode],
            { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
          );
          t.after(() => {
            if (worker.exitCode === null) worker.kill();
          });
          return worker;
        };
        const a = spawn('a');
        const b = spawn('b');
        const exits = [once(a, 'exit'), once(b, 'exit')];
        const ready = await Promise.all([once(a, 'message'), once(b, 'message')]);
        for (const [message] of ready) assert.deepEqual(message, { status: 'ready' });
        const results = [once(a, 'message'), once(b, 'message')];
        a.send('start');
        b.send('start');
        const statuses = (await Promise.all(results)).map(
          ([message]) => (message as { status: string }).status,
        );
        await Promise.all(exits);
        assert.equal(statuses.filter((status) => status === 'reserved').length, 1);
        assert.ok(
          statuses.every((status) =>
            ['reserved', 'limit_reached', 'database_error'].includes(status),
          ),
        );
        const row = await client.imageDailyQuota.findFirstOrThrow();
        assert.equal(row.legacyUsed, config.IMAGE_MAX_PER_USER_PER_DAY - 1);
        assert.equal(row.used, config.IMAGE_MAX_PER_USER_PER_DAY);
        await assert.rejects(client.imageDailyQuota.deleteMany());
        const winner = statuses[0] === 'reserved' ? 'a' : 'b';
        await new ImageQuotaService(client, () => time).finish(winner, 'released');
        const crash = spawn('interrupted', 'crash');
        const crashed = once(crash, 'exit');
        await once(crash, 'message');
        crash.send('start');
        await crashed;
        await client.$disconnect();
        const reopened = new PrismaClient({ datasources: { db: { url } } });
        clients.push(reopened);
        const quota = new ImageQuotaService(reopened, () => time);
        assert.equal((await reserve(quota, 'interrupted', 'worker')).status, 'already_processed');
        assert.equal((await reserve(quota, 'after-restart', 'worker')).status, 'limit_reached');
        assert.equal(
          (await reopened.imageDailyQuota.findFirstOrThrow()).used,
          config.IMAGE_MAX_PER_USER_PER_DAY,
        );
        assert.equal((await reserve(quota, 'independent', 'another-user')).status, 'reserved');
      },
    );

    await t.test('upgrade preserves legacy rows and statistics', async () => {
      const folder = path.join(root, 'upgrade');
      await mkdir(folder);
      await cp('prisma/schema.prisma', path.join(folder, 'schema.prisma'));
      await cp('prisma/migrations', path.join(folder, 'migrations'), { recursive: true });
      // Копируем только схему/миграции, рабочие базы не используются.
      const migrations = await readdir('prisma/migrations');
      assert.ok(migrations.includes(migrationName));
      await rm(path.join(folder, 'migrations', migrationName), { recursive: true, force: true });
      const url = `file:${path.join(root, 'upgrade.db')}`;
      migrate(path.join(folder, 'schema.prisma'), url);
      const client = new PrismaClient({ datasources: { db: { url } } });
      clients.push(client);
      await client.apiUsage.create({
        data: {
          provider: 'openai',
          feature: 'image_edit',
          vkUserId: 'legacy',
          createdAt: time,
          estimatedCost: 0.75,
        },
      });
      await client.$disconnect();
      await cp(
        path.join('prisma/migrations', migrationName),
        path.join(folder, 'migrations', migrationName),
        { recursive: true },
      );
      migrate(path.join(folder, 'schema.prisma'), url);
      const quota = new ImageQuotaService(client, () => time);
      assert.equal((await reserve(quota, 'upgrade', 'legacy')).status, 'reserved');
      const row = await client.imageDailyQuota.findFirstOrThrow();
      assert.equal(row.legacyUsed, 1);
      assert.equal(row.used, 2);
      assert.equal(
        (await client.apiUsage.aggregate({ _sum: { estimatedCost: true } }))._sum.estimatedCost,
        0.75,
      );
      assert.equal(await client.apiUsage.count(), 1);
    });
  },
);
