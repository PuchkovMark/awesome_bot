import OpenAI from 'openai';
import config from '../../config/index.js';

export interface MemoryEmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Вычисляет векторные представления воспоминаний для семантического поиска.
 */
export class OpenAIMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly model = config.MEMORY_EMBEDDING_MODEL;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 8_000 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return response.data
      .toSorted((left, right) => left.index - right.index)
      .map(({ embedding }) => embedding);
  }
}

export function createMemoryEmbeddingProvider(): MemoryEmbeddingProvider | undefined {
  return config.MEMORY_EMBEDDING_API_KEY
    ? new OpenAIMemoryEmbeddingProvider(config.MEMORY_EMBEDDING_API_KEY)
    : undefined;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
