import OpenAI from 'openai';
import config from '../../config';
import { logger } from '../../logger';
import type { AIProvider, AIMessage, AIResponse } from './AIProvider';

/**
 * OpenAIProvider — реализация AIProvider для OpenAI-совместимых API.
 */
export class OpenAIProvider implements AIProvider {
  public name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor() {
    const apiKey = config.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for OpenAIProvider');
    this.client = new OpenAI({ apiKey });
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  }

  async send(messages: AIMessage[], options?: { maxTokens?: number; temperature?: number }): Promise<AIResponse> {
    try {
      const chatMessages = messages.map((m) => ({ role: m.role, content: m.content }));

      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: chatMessages,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
      });

      const choice = res.choices?.[0];
      const content = choice?.message?.content ?? '';
      const tokens = (res.usage as any)?.total_tokens ?? undefined;

      return { id: res.id, content, provider: this.name, tokens };
    } catch (err) {
      logger.error({ err }, 'OpenAIProvider send failed');
      throw err;
    }
  }
}

export default OpenAIProvider;
