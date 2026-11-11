/**
 * Интерфейс AIProvider — единый контракт для всех провайдеров нейросетей.
 */
export type AIMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AIResponse = {
  id?: string;
  content: string;
  provider?: string;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type AITool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown) => Promise<string>;
};

export type AIRequestOptions = {
  sessionId?: string;
  tools?: readonly AITool[];
};

export interface AIProvider {
  /**
   * Отправляет массив сообщений (контекст + запрос) и возвращает ответ.
   */
  send(messages: AIMessage[], options?: AIRequestOptions): Promise<AIResponse>;

  /**
   * Имя провайдера (например, 'openai').
   */
  name: string;
}

export default AIProvider;
