import type { ToolContext, ToolDefinition } from '../contracts/tool';
import type { JsonValue } from '../contracts/json';
import type { LlmToolCall, LlmToolDescription } from '../llm/types';
import { toolAuthorization } from './authorization';

export interface ToolReply {
  readonly text: string;
  readonly subjectIds?: readonly import('../contracts/index').UserId[];
  readonly sourceIds?: readonly number[];
  readonly outcome?: 'success' | 'failed' | 'denied';
  readonly current?: () => boolean;
}
export interface RuntimeTool extends Omit<
  ToolDefinition<Record<string, unknown>, ToolReply>,
  'execute'
> {
  execute(
    args: Record<string, unknown>,
    context: ToolContext,
    call: LlmToolCall,
  ): Promise<ToolReply>;
}
export type ToolExecution = ToolReply & { readonly outcome: 'success' | 'denied' | 'failed' };
const denied: ToolExecution = { text: '{"error":"tool_denied"}', outcome: 'denied' };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// Исполняемые схемы используют только этот набор ограничений. Новые keywords закрыты по умолчанию.
function matches(schema: unknown, value: unknown): boolean {
  if (!object(schema)) return false;
  const allowed = [
    'type',
    'description',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'maxItems',
  ];
  if (Object.keys(schema).some((k) => !allowed.includes(k))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'object': {
      if (!object(value)) return false;
      const properties = schema.properties ?? {};
      if (
        !object(properties) ||
        (schema.required !== undefined &&
          (!Array.isArray(schema.required) ||
            !schema.required.every((k) => typeof k === 'string' && Object.hasOwn(value, k))))
      )
        return false;
      return Object.keys(value).every(
        (k) =>
          ![
            '__proto__',
            'constructor',
            'prototype',
            'chatId',
            'userId',
            'role',
            'generation',
            'platform',
          ].includes(k) &&
          Object.hasOwn(properties, k) &&
          matches(properties[k], value[k]),
      );
    }
    case 'array':
      return (
        Array.isArray(value) &&
        (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems) &&
        value.every((v) => matches(schema.items, v))
      );
    case 'string':
      return (
        typeof value === 'string' &&
        (typeof schema.minLength !== 'number' || value.length >= schema.minLength) &&
        (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength)
      );
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type !== 'integer' || Number.isSafeInteger(value)) &&
        (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
        (typeof schema.maximum !== 'number' || value <= schema.maximum)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}
export function createToolRegistry(
  tools: readonly RuntimeTool[],
  context: ToolContext,
  current: () => boolean,
  canWrite?: (name: string) => Promise<boolean>,
) {
  const definitions = new Map(tools.map((t) => [t.name, t]));
  if (definitions.size !== tools.length || tools.some((t) => !/^\w[\w.-]{0,63}$/.test(t.name)))
    throw new TypeError('Некорректный реестр инструментов.');
  async function available(readOnly = false) {
    if (
      !current() ||
      !toolAuthorization(context).allowed ||
      !context.chatId.startsWith(context.platform + ':')
    )
      return [];
    const candidates = tools.filter(
      (t) =>
        (!readOnly || t.access === 'read') &&
        (!t.platforms || t.platforms === 'all' || t.platforms.includes(context.platform)),
    );
    const caps = candidates.some((t) => t.requiredCapabilities?.length)
      ? await context.adapter.capabilities({ chatId: context.chatId, userId: context.userId })
      : undefined;
    if (!current()) return [];
    return candidates.filter(
      (t) =>
        !t.requiredCapabilities?.length ||
        (caps?.context.chatId === context.chatId &&
          (caps.context.userId === undefined || caps.context.userId === context.userId) &&
          t.requiredCapabilities.every((c) => caps.support[c] === 'supported')),
    );
  }
  return {
    async schemas(readOnly = false): Promise<LlmToolDescription[]> {
      return (await available(readOnly)).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
    },
    async execute(
      call: LlmToolCall,
      issued: readonly LlmToolDescription[],
      readOnly = false,
    ): Promise<ToolExecution> {
      try {
        if (!issued.some((t) => t.name === call.name)) return denied;
        const def = definitions.get(call.name);
        if (!def || !(await available(readOnly)).includes(def)) return denied;
        let args: unknown;
        try {
          args = JSON.parse(call.arguments) as JsonValue;
        } catch {
          return denied;
        }
        if (!object(args) || !matches(def.parameters, args)) return denied;
        if (def.access === 'write' && !(await canWrite?.(def.name))) return denied;
        if (!current() || !toolAuthorization(context).allowed) return denied;
        const reply = await def.execute(args, context, call);
        if (!current() || (reply.current && !reply.current())) return denied;
        return { ...reply, outcome: reply.outcome ?? 'success' };
      } catch {
        return { text: '{"error":"tool_failed"}', outcome: 'failed' };
      }
    },
  };
}
