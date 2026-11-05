import OpenAI from 'openai';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import type { AIProvider, AIMessage, AIResponse } from './AIProvider.js';

export class OpenAIProvider implements AIProvider {
  public readonly name = 'openai';
  private readonly client: OpenAI;

  constructor() {
    if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for OpenAI');
    this.client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      maxRetries: config.AI_MAX_RETRIES,
      timeout: 90_000,
    });
  }

  async send(
    messages: AIMessage[],
    options?: { maxTokens?: number; temperature?: number; sessionId?: string },
  ): Promise<AIResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: config.OPENAI_MODEL,
        messages,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
      });
      return {
        id: response.id,
        content: response.choices[0]?.message.content ?? '',
        provider: this.name,
        tokens: response.usage?.total_tokens,
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      };
    } catch (err) {
      logger.error({ err, provider: this.name }, 'AI provider send failed');
      throw err;
    }
  }
}

export default OpenAIProvider;
