import { writeSync } from 'node:fs';
import type { Writable } from 'node:stream';
import { loadApplicationConfig, loadPromptConfig, loadResolutionConfig } from '../config/application.js';
import { ConfigError } from '../config/index.js';
import type { ConfigOptions } from '../config/index.js';
import { createLogger, reportConfigError } from '../logger/index.js';
import type { ApplicationFailure } from '../logger/types.js';
import { runApplication } from './service.js';
import { applicationChatId, initializePrompt, resolveApplicationChat } from './setup.js';

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
    if (args.length === 1 && args[0] === 'start') {
      const { config, redact } = loadApplicationConfig(options.config);
      const logger = createLogger({ level: config.log.level, redact, destination });
      const result = await runApplication(config, logger, options.signal ?? new AbortController().signal, options.dependencies);
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
      const decision = args[2] === '--continue' ? 'continue' : args[2] === '--new' ? 'new' : undefined;
      if (!chatId || !decision) return fail('invalid_arguments');
      const config = loadResolutionConfig(options.config);
      try { await resolveApplicationChat(config, chatId, decision); }
      catch { return fail('resolution_failed'); }
      createLogger({ destination }).event({ event: 'chat_resolved' }, 'info');
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

export async function runProcess(args: readonly string[], options: Omit<CliOptions, 'signal'> = {}) {
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
