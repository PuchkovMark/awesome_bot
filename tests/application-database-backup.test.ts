import { spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync, renameSync, statSync, truncateSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { runBackup } from '../src/app/database-backup';
import { openStorage } from '../src/storage/index';
import { openExisting } from '../src/storage/database-backup';
import { storageFixture } from './helpers/storage-fixture';
import { scopeFor } from './helpers/connection-scope';

const day = 86_400_000,
  start = Date.UTC(2026, 0, 2);
const fixtures: ReturnType<typeof storageFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
async function setup() {
  const f = storageFixture();
  fixtures.push(f);
  const app = await openStorage(f.path);
  const scope = scopeFor(app, 'vk:a');
  await app.messages.append(scope, {
    chatId: scope.chatId,
    messageId: '1',
    role: 'user',
    authorName: '',
    userId: 'vk:u',
    text: 'первая',
    timestamp: start,
  });
  await app.close();
  const config = { databasePath: f.path, messageRetentionDays: 30 };
  return { f, config, latest: join(f.directory, 'backups', 'latest.sqlite') };
}
function cli(path: string, action: string) {
  return spawnSync(process.execPath, [resolve('dist/app/cli.js'), 'backup', action], {
    cwd: join(path, '..'),
    env: { DATABASE_PATH: path, MESSAGE_RETENTION_DAYS: '30' },
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('два суточных снимка, повтор и пропущенные дни оставляют один свежий файл', async () => {
  const { f, config, latest } = await setup();
  let now = start;
  const hooks = { now: () => now };
  expect(await runBackup(config, 'create', hooks)).toMatchObject({
    ok: true,
    outcome: 'created',
    latestAt: start,
  });
  expect(await runBackup(config, 'create', hooks)).toMatchObject({
    outcome: 'already_created_today',
  });
  const app = await openStorage(f.path);
  await app.messages.append(scopeFor(app, 'vk:a'), {
    chatId: 'vk:a',
    messageId: '2',
    role: 'user',
    authorName: '',
    userId: 'vk:u',
    text: 'вторая',
    timestamp: now + day,
  });
  await app.close();
  now += 3 * day;
  expect(await runBackup(config, 'create', hooks)).toMatchObject({
    ok: true,
    latestAt: now,
    verification: { access: { access: 'full' } },
  });
  expect(readdirSync(join(f.directory, 'backups'))).toEqual(['latest.sqlite']);
  expect(statSync(latest).mode & 0o077).toBe(0);
  const saved = openExisting(latest);
  try {
    expect(saved.prepare('SELECT text FROM messages ORDER BY id').pluck().all()).toEqual([
      'первая',
      'вторая',
    ]);
  } finally {
    saved.close();
  }
  expect(await runBackup(config, 'verify', hooks)).toMatchObject({ ok: true });
});

test('прерывания до замены сохраняют прежний файл, авария после rename распознаётся при открытии', async () => {
  const { f, config, latest } = await setup();
  await runBackup(config, 'create', { now: () => start });
  const inode = statSync(latest).ino;
  const module = pathToFileURL(resolve('dist/app/database-backup.js')).href;
  for (const phase of ['copied', 'verified', 'before_publish', 'after_publish']) {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const {runBackup}=await import(process.argv[1]);
      await runBackup({databasePath:process.argv[2],messageRetentionDays:30},'create',{
        now:()=>Number(process.argv[3]),checkpoint:stage=>{if(stage===process.argv[4])process.kill(process.pid,'SIGKILL')}
      });
    `,
        module,
        f.path,
        String(start + day),
        phase,
      ],
      { cwd: f.directory, timeout: 20000 },
    );
    expect(child.signal).toBe('SIGKILL');
    const after = phase === 'after_publish';
    expect(statSync(latest).ino === inode).toBe(!after);
    expect(await runBackup(config, 'status', { now: () => start + day })).toMatchObject({
      ok: true,
      latestAt: after ? start + day : start,
      attempt: { outcome: after ? 'created' : 'interrupted' },
    });
    expect(readdirSync(join(f.directory, 'backups'))).toEqual(['latest.sqlite']);
    expect(await runBackup(config, 'verify', { now: () => start + day })).toMatchObject({
      ok: true,
    });
  }
});

test('граница 30 суток, неудачная попытка и утрата источника не продлевают срок', async () => {
  const { f, config } = await setup();
  await runBackup(config, 'create', { now: () => start });
  renameSync(f.path, f.path + '.old');
  expect(await runBackup(config, 'verify', { now: () => start + 30 * day - 1 })).toMatchObject({
    ok: false,
    outcome: 'database_missing',
    latestAt: start,
  });
  expect(await runBackup(config, 'create', { now: () => start + 30 * day })).toMatchObject({
    ok: false,
    outcome: 'database_missing',
    latestAt: null,
  });
  expect(readdirSync(join(f.directory, 'backups'))).toEqual([]);
});

test('CLI без сетевых секретов, параллельная попытка, подмена источника и повреждение снимка', async () => {
  const { f, config, latest } = await setup();
  let concurrent;
  expect(
    await runBackup(config, 'create', {
      checkpoint: (stage) => {
        if (stage === 'copied') concurrent = cli(f.path, 'create');
      },
    }),
  ).toMatchObject({ ok: true });
  expect(concurrent).toMatchObject({ status: 1, stdout: expect.stringContaining('backup_busy') });
  const checked = cli(f.path, 'verify');
  expect(checked.status, checked.stdout).toBe(0);
  renameSync(f.path, f.path + '.old');
  copyFileSync(latest, f.path);
  expect(await runBackup(config, 'verify')).toMatchObject({
    ok: false,
    outcome: 'untrusted_source',
  });
  truncateSync(latest, 200);
  expect((await runBackup(config, 'verify')).ok).toBe(false);
});
