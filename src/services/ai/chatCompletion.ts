import type OpenAI from 'openai';
import type { AIMessage, AIRequestOptions, AIResponse } from './AIProvider.js';
import type { ReasoningEffort } from './effort.js';

export async function sendChatCompletion(
  client: OpenAI,
  model: string,
  provider: string,
  messages: AIMessage[],
  effort: ReasoningEffort,
  maxOutputTokens: number,
  options?: AIRequestOptions,
  headers?: Record<string, string>,
): Promise<AIResponse> {
  const maxToolCalls = options?.maxToolCalls ?? 10;
  const availableTools = options?.tools ?? [];
  const toolsByName = new Map(availableTools.map((tool) => [tool.name, tool]));
  if (toolsByName.size !== availableTools.length) {
    throw new Error('AI tool names must be unique');
  }
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = availableTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  const conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [...messages];
  let totalTokens: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let toolCallCount = 0;

  for (let round = 0; round <= maxToolCalls; round += 1) {
    const response = await client.chat.completions.create(
      {
        model,
        messages: conversation,
        // OpenAI-совместимые провайдеры (включая OpenCode) ожидают max_tokens.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        max_tokens: maxOutputTokens,
        reasoning_effort: effort,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
      },
      headers ? { headers } : undefined,
    );
    if (response.usage) {
      totalTokens = (totalTokens ?? 0) + response.usage.total_tokens;
      inputTokens = (inputTokens ?? 0) + response.usage.prompt_tokens;
      outputTokens = (outputTokens ?? 0) + response.usage.completion_tokens;
    }

    const choice = response.choices[0];
    if (!choice) throw new Error('AI provider returned no completion choices');
    if (choice.finish_reason === 'length') {
      throw new Error(`AI response exceeded the output token limit (${maxOutputTokens})`);
    }
    if (choice.finish_reason === 'content_filter') {
      throw new Error('AI response was blocked by the provider content filter');
    }
    const { message } = choice;
    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (choice.finish_reason === 'tool_calls' || Object.hasOwn(message, 'function_call')) {
        throw new Error('AI provider returned an unsupported tool call');
      }
      const content = message.content ?? message.refusal;
      if (!content) throw new Error('AI provider returned an empty response');
      return {
        id: response.id,
        content,
        provider,
        tokens: totalTokens,
        inputTokens,
        outputTokens,
      };
    }

    toolCallCount += toolCalls.length;
    if (toolCallCount > maxToolCalls) {
      throw new Error(`AI tool call limit exceeded (${maxToolCalls})`);
    }
    conversation.push(message);
    for (const call of toolCalls) {
      if (call.type !== 'function') throw new Error('AI requested an unsupported tool call type');
      const tool = toolsByName.get(call.function.name);
      if (!tool) throw new Error('AI requested an unavailable tool');
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw new Error(`AI returned invalid arguments for tool ${tool.name}`);
      }
      const result = await tool.execute(args);
      conversation.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  throw new Error(`AI tool call limit exceeded (${maxToolCalls})`);
}
