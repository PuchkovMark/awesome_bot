import { createHash, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import settingsService from '../settings/settingsService.js';
import type { AIProvider, AIMessage, AIRequestOptions, AIResponse } from './AIProvider.js';
import { sendChatCompletion } from './chatCompletion.js';
import { resolveReasoningEffort, TEXT_MODEL } from './effort.js';

/**
 * Отправляет запросы к OpenCode Console через совместимый с OpenAI API и нормализует ответы.
 */
export class OpenCodeProvider implements AIProvider {
  public readonly name = 'opencode';
  private client: OpenAI;

  constructor() {
    if (!config.OPENCODE_API_KEY)
      throw new Error('OPENCODE_API_KEY is required for OpenCode Console');
    this.client = new OpenAI({
      apiKey: config.OPENCODE_API_KEY,
      baseURL: config.OPENCODE_BASE_URL,
      maxRetries: config.AI_MAX_RETRIES,
      timeout: 90_000,
      defaultHeaders: {
        'User-Agent': 'awesome-bot/0.1.0',
      },
    });
  }

  async send(messages: AIMessage[], options?: AIRequestOptions): Promise<AIResponse> {
    try {
      const savedEffort = await settingsService.getAppSetting('ai_effort');
      const effort = resolveReasoningEffort(savedEffort, config.AI_EFFORT);
      if (!effort) throw new Error(`Unsupported saved AI effort: ${savedEffort}`);
      return await sendChatCompletion(
        this.client,
        TEXT_MODEL,
        this.name,
        messages,
        effort,
        config.AI_MAX_OUTPUT_TOKENS,
        options,
        {
          'x-opencode-session': options?.sessionId
            ? `ses_${createHash('sha256').update(options.sessionId).digest('hex').slice(0, 32)}`
            : `ses_${randomUUID().replaceAll('-', '')}`,
        },
      );
    } catch (err) {
      logger.error({ err, provider: this.name }, 'AI provider send failed');
      throw err;
    }
  }
}

export default OpenCodeProvider;
