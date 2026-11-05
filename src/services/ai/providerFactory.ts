import type AIProvider from './AIProvider.js';
import OpenCodeProvider from './opencodeProvider.js';
import OpenAIProvider from './openaiProvider.js';

export function getAIProvider(name = 'opencode'): AIProvider {
  switch (name) {
    case 'opencode':
      return new OpenCodeProvider();
    case 'openai':
      return new OpenAIProvider();
    default:
      throw new Error(`Unsupported AI provider: ${name}`);
  }
}

export default getAIProvider;
