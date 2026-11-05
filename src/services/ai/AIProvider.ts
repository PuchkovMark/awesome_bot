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

export interface AIProvider {
  /**
   * Отправляет массив сообщений (контекст + запрос) и возвращает ответ.
   */
  send(
    messages: AIMessage[],
    options?: { maxTokens?: number; temperature?: number; sessionId?: string },
  ): Promise<AIResponse>;

  /**
   * Имя провайдера (например, 'openai').
   */
  name: string;
}

export default AIProvider;
