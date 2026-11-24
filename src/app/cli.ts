import { writeSync } from 'node:fs';
import type { Writable } from 'node:stream';
import {
  loadApplicationConfig,
  loadBackupConfig,
  loadPromptConfig,
  loadResolutionConfig,
} from '../config/application';
import { ConfigError } from '../config/index';
import type { ConfigOptions } from '../config/index';
import { createLogger, reportConfigError } from '../logger/index';
import type { ApplicationFailure } from '../logger/types';
import { runApplication } from './service';
import { runBackup } from './database-backup';
import {
  applicationChatId,
  applicationGroupId,
  configureDisclosure,
  confirmApplicationDisclosure,
  deleteApplicationChatData,
  initializePrompt,
  readAdminRecovery,
  readOnboarding,
  requestDisclosureUpdate,
  resolveApplicationChat,
} from './setup';

interface CliOptions {
  readonly config?: ConfigOptions;
  readonly destination?: Writable;
  readonly signal?: AbortSignal;
  readonly dependencies?: Parameters<typeof runApplication>[3];
}

export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const destination = options.destination ?? process.stdout;
  function fail(reason: ApplicationFailure, code = 1) {
    createLogger({ level: 'error', destination }).event({ event: 'application_failed', reason });
    return code;
  }

  try {
    if (args[0] === 'backup') {
      const action = args[1];
      if (args.length !== 2 || (action !== 'create' && action !== 'verify' && action !== 'status'))
        return fail('invalid_arguments');
      const result = await runBackup(loadBackupConfig(options.config), action);
      destination.write(JSON.stringify(result) + '\n');
      return result.ok ? 0 : 1;
    }
    if (args.length === 1 && args[0] === 'start') {
      const { config, redact } = loadApplicationConfig(options.config);
      const logger = createLogger({ level: config.log.level, redact, destination });
      const result = await runApplication(
        config,
        logger,
        options.signal ?? new AbortController().signal,
        options.dependencies,
      );
      if (result) return fail(result, result === 'stop_timeout' ? 2 : 1);
      logger.event({ event: 'application_stopped' }, 'info');
      return 0;
    }
    if (args.length === 2 && args[0] === 'init-prompt' && args[1]) {
      const error = await initializePrompt(loadPromptConfig(options.config), args[1]);
      if (error) return fail(error);
      createLogger({ destination }).event({ event: 'prompt_initialized' }, 'info');
      return 0;
    }
    if (args.length === 3 && args[0] === 'resolve-chat' && args[1]) {
      const chatId = applicationChatId(args[1]);
      const decision =
        args[2] === '--continue' ? 'continue' : args[2] === '--new' ? 'new' : undefined;
      if (!chatId || !decision) return fail('invalid_arguments');
      const config = loadResolutionConfig(options.config);
      try {
        await resolveApplicationChat(config, chatId, decision);
      } catch {
        return fail('resolution_failed');
      }
      createLogger({ destination }).event({ event: 'chat_resolved' }, 'info');
      return 0;
    }
    if (args.length === 2 && args[0] === 'set-disclosure' && args[1]) {
      const version = await configureDisclosure(loadResolutionConfig(options.config), args[1]);
      destination.write(JSON.stringify({ version }) + '\n');
      return 0;
    }
    if (args[0] === 'onboarding-status' && args.length <= 2) {
      const target = args[1] === undefined ? undefined : applicationGroupId(args[1]);
      if (args[1] !== undefined && !target) return fail('invalid_arguments');
      const status = await readOnboarding(loadResolutionConfig(options.config), target);
      destination.write(JSON.stringify(status) + '\n');
      return 0;
    }
    if (args[0] === 'admin-recovery-status' && args.length === 2) {
      const target = applicationGroupId(args[1]!);
      if (!target) return fail('invalid_arguments');
      destination.write(
        JSON.stringify(await readAdminRecovery(loadResolutionConfig(options.config), target)) +
          '\n',
      );
      return 0;
    }
    if (args.length === 2 && args[0] === 'publish-disclosure' && args[1]) {
      const target = applicationGroupId(args[1]);
      if (!target || !(await requestDisclosureUpdate(loadResolutionConfig(options.config), target)))
        return fail('resolution_failed');
      return 0;
    }
    if (args.length === 3 && args[0] === 'delete-chat-data' && args[1] && args[2]) {
      const target = applicationGroupId(args[1]);
      const generation = Number(args[2]);
      if (
        !target ||
        !Number.isSafeInteger(generation) ||
        generation <= 0 ||
        String(generation) !== args[2]
      )
        return fail('invalid_arguments');
      await deleteApplicationChatData(loadResolutionConfig(options.config), target, generation);
      return 0;
    }
    if (
      (args.length === 3 || args.length === 4) &&
      args[0] === 'confirm-disclosure' &&
      args[1] &&
      args[2]
    ) {
      const target = applicationChatId(args[1]);
      const receipt = args[2];
      const version = args[3] === undefined ? undefined : Number(args[3]);
      if (
        !target ||
        !/^[1-9]\d*$/u.test(receipt) ||
        (version !== undefined &&
          (!Number.isSafeInteger(version) || version <= 0 || String(version) !== args[3]))
      )
        return fail('invalid_arguments');
      if (
        !(await confirmApplicationDisclosure(
          loadApplicationConfig(options.config).config,
          target,
          receipt,
          version,
        ))
      )
        return fail('resolution_failed');
      return 0;
    }
    return fail('invalid_arguments');
  } catch (error) {
    if (error instanceof ConfigError) {
      reportConfigError(error, destination);
      return 1;
    }
    return fail('storage_failed');
  }
}

export async function runProcess(
  args: readonly string[],
  options: Omit<CliOptions, 'signal'> = {},
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (args[0] === 'start') {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
  try {
    return await runCli(args, { ...options, signal: controller.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (import.meta.main) {
  const exitCode = await runProcess(process.argv.slice(2));
  if (exitCode === 2) {
    writeSync(2, '{"event":"application_failed","reason":"stop_timeout"}\n');
    process.exit(exitCode);
  }
  process.exitCode = exitCode;
}
