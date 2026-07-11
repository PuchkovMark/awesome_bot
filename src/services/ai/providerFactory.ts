import container from '../../di/container.js';
import type AIProvider from './AIProvider.js';
import OpenAIProvider from './openaiProvider.js';
import { logger } from '../../logger/index.js';
import config from '../../config/index.js';

const KEY = 'ai.provider';

// Register default providers
function registerProviders() {
  // OpenAI
  container.register<AIProvider>('ai.openai', () => new OpenAIProvider());

  // Default provider factory chooses based on env or falls back to openai
  container.register<AIProvider>(KEY, () => {
    const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
    logger.info({ provider }, 'Selected AI provider');
    switch (provider) {
      case 'openai':
      default:
        return container.resolve<AIProvider>('ai.openai');
    }
  });
}

registerProviders();

export function getAIProvider(): AIProvider {
  // Ensure OPENAI key present if provider is openai
  if ((process.env.AI_PROVIDER || 'openai').toLowerCase() === 'openai' && !config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for OpenAI provider');
  }
  return container.resolve<AIProvider>(KEY);
}

export default getAIProvider;
