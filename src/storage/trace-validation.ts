import { requireInput } from './validation';
import { StorageError } from './errors';
import type { TracePayload } from './trace-types';
export const traceRows = [
  'complete',
  'unusable_response',
  'unsuccessful',
  'queue_full',
  'quota_exhausted',
  'token_budget_exhausted',
  'current_message_too_large',
  'static_budget_too_small',
  'trace_write_failed',
  'silent_outcome',
  'invalid_route',
] as const;
function plain(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  requireInput(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireInput(
    Reflect.ownKeys(descriptors).every(
      (k) =>
        typeof k === 'string' &&
        (keys.includes(k) || optional.includes(k)) &&
        'value' in descriptors[k]!,
    ),
  );
  requireInput(keys.every((k) => Object.hasOwn(descriptors, k)));
  return value as Record<string, unknown>;
}
function num(v: unknown) {
  requireInput(
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER,
  );
}
function text(v: unknown, max = 1024) {
  requireInput(typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= max);
}
function one(v: unknown, values: readonly unknown[]) {
  requireInput(values.includes(v));
}
function list(v: unknown, max: number, fn: (v: unknown) => void) {
  requireInput(Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype && v.length <= max);
  requireInput(
    Reflect.ownKeys(v).every(
      (k) =>
        k === 'length' ||
        (typeof k === 'string' && /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < v.length),
    ),
  );
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    requireInput(d && 'value' in d);
    fn(d.value);
  }
}
export function validateTrace(value: unknown): asserts value is TracePayload {
  const p = plain(
    value,
    [
      'model',
      'prompt',
      'context',
      'summary',
      'route',
      'resultKind',
      'preparationFailure',
      'publication',
      'degraded',
      'degradation',
      'tools',
    ],
    ['disclosure'],
  );
  if (Object.hasOwn(p, 'disclosure')) {
    const disclosure = plain(p.disclosure, ['version', 'allowed']);
    requireInput(typeof disclosure.allowed === 'boolean');
    if (disclosure.version !== null)
      requireInput(Number.isSafeInteger(disclosure.version) && (disclosure.version as number) > 0);
    if (disclosure.allowed) requireInput(disclosure.version !== null);
  }
  const model = plain(p.model, ['name', 'invoked']);
  if (model.name !== null) text(model.name);
  one(model.invoked, ['no', 'possible', 'yes']);
  one(p.resultKind, [
    null,
    'complete',
    'incomplete',
    'refused',
    'empty',
    'rate_limit',
    'quota_exhausted',
    'token_budget_exhausted',
    'initiative_budget_exhausted',
    'tools_not_supported',
    'cancelled',
    'deadline_exceeded',
    'attempt_limit',
    'error',
    'completed',
    'failed',
    'interrupted',
    'expired',
    'message_missing',
  ]);
  one(p.preparationFailure, [
    null,
    'missing_system_prompt',
    'static_budget_too_small',
    'current_message_too_large',
    'internal_error',
  ]);
  requireInput(typeof p.degraded === 'boolean');
  one(p.degradation, ['none', 'write_failed', 'size_exceeded', 'legacy_metadata_missing']);
  const pub = plain(p.publication, ['rowId', 'tableVersion', 'reaction', 'status', 'reason']);
  one(pub.rowId, traceRows);
  one(pub.tableVersion, [1]);
  one(pub.reaction, ['answer', 'notice', 'silence']);
  one(pub.status, ['pending_checks', 'allowed', 'suppressed', 'delivered', 'failed', 'unknown']);
  one(pub.reason, [
    'none',
    'no_port',
    'guard',
    'no_reply',
    'notice_period',
    'response_rate',
    'trace_write_failed',
    'publication_failed',
    'journal_failed',
    'partial_delivery',
  ]);
  if (p.route !== null) {
    const r = plain(p.route, ['kind', 'mode', 'isGroupChat']);
    one(r.kind, ['direct_message', 'mention', 'reply', 'name']);
    one(r.mode, ['normal', 'active']);
    requireInput(typeof r.isGroupChat === 'boolean');
  }
  if (p.prompt !== null) {
    const v = plain(p.prompt, ['area', 'kind', 'key', 'version']);
    one(v.area, ['global']);
    one(v.kind, ['system_prompt']);
    text(v.key);
    num(v.version);
  }
  if (p.context !== null) {
    const c = plain(p.context, [
      'version',
      'cutoffId',
      'messageIds',
      'layerBytes',
      'estimatedTokens',
      'scanned',
      'historyTruncated',
      'reply',
      'absentLayers',
    ]);
    const v = plain(c.version, ['area', 'kind', 'key', 'version']);
    one(v.area, ['global']);
    one(v.kind, ['system_prompt']);
    text(v.key);
    num(v.version);
    num(c.cutoffId);
    list(c.messageIds, 4096, num);
    const bytes = plain(c.layerBytes, ['system', 'environment', 'messages']);
    Object.values(bytes).forEach(num);
    num(c.estimatedTokens);
    num(c.scanned);
    requireInput(typeof c.historyTruncated === 'boolean');
    one(c.reply, ['none', 'included', 'truncated', 'unavailable']);
    list(c.absentLayers, 8, (v) =>
      one(v, [
        'persona',
        'passport',
        'profiles',
        'memory',
        'summaries',
        'summary',
        'trace',
        'tracing',
      ]),
    );
  }
  if (p.summary !== null) {
    const s = plain(p.summary, ['steps', 'attempts', 'attemptsPerStep', 'durationMs', 'usage']);
    num(s.steps);
    num(s.attempts);
    num(s.durationMs);
    list(s.attemptsPerStep, 64, num);
    const u = plain(s.usage, ['input', 'output']);
    for (const x of Object.values(u)) {
      const t = plain(x, ['knownTokens', 'unknownAttempts', 'overflowed']);
      if (t.knownTokens !== null) num(t.knownTokens);
      num(t.unknownAttempts);
      requireInput(typeof t.overflowed === 'boolean');
    }
  }
  list(p.tools, 1024, (x) => {
    const t = plain(x, ['name', 'outcome', 'bytes', 'durationMs']);
    text(t.name, 128);
    requireInput(/^[a-zA-Z0-9_.-]+$/.test(t.name as string));
    one(t.outcome, ['success', 'failed', 'denied']);
    num(t.bytes);
    num(t.durationMs);
  });
}
export function encodeTrace(value: unknown, max: number): string {
  validateTrace(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > max) throw new StorageError('limit_exceeded');
  return json;
}
