import type AIProvider from './AIProvider.js';
import OpenCodeProvider from './opencodeProvider.js';

export function getAIProvider(): AIProvider {
  return new OpenCodeProvider();
}

export default getAIProvider;
