import { createHash, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import type { AIProvider, AIMessage, AIResponse } from './AIProvider.js';

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

  async send(
    messages: AIMessage[],
    options?: { maxTokens?: number; temperature?: number; sessionId?: string },
  ): Promise<AIResponse> {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: config.OPENCODE_MODEL,
          messages,
          max_tokens: options?.maxTokens,
          temperature: options?.temperature,
        },
        {
          headers: {
            'x-opencode-session': options?.sessionId
              ? `ses_${createHash('sha256').update(options.sessionId).digest('hex').slice(0, 32)}`
              : `ses_${randomUUID().replaceAll('-', '')}`,
          },
        },
      );

      const choice = res.choices?.[0];
      const content = choice?.message?.content ?? '';
      const tokens = res.usage?.total_tokens;

      return {
        id: res.id,
        content,
        provider: this.name,
        tokens,
        inputTokens: res.usage?.prompt_tokens,
        outputTokens: res.usage?.completion_tokens,
      };
    } catch (err) {
      logger.error({ err, provider: this.name }, 'AI provider send failed');
      throw err;
    }
  }
}

export default OpenCodeProvider;
