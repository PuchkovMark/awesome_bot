import container from '../../di/container';
import type AIProvider from './AIProvider';
import OpenAIProvider from './openaiProvider';
import { logger } from '../../logger';
import config from '../../config';

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
